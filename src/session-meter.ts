/**
 * cookbook-meter core: turns local Claude Code session transcripts into
 * metadata-only usage summaries with API-equivalent dollar figures.
 *
 * Reads ~/.claude/projects/** transcripts (*.jsonl, including per-session
 * subagents/ transcripts, which fold into their parent session) and produces
 * per-day, per-session aggregates.
 *
 * PRIVACY IS A HARD RULE: the output contains ONLY counts, model ids,
 * timestamps, durations, repo basenames, and dollars. Prompt/response content
 * is never read into any output structure.
 *
 * Cost is API-EQUIVALENT USD (what this usage would have cost at standard API
 * rates; actual billing is typically a Claude subscription). Cache-write is
 * priced at the 5-minute-TTL rate (1.25x input) for every cache_creation
 * token; Claude Code also uses 1h caching (2x), so the cache-write figure is
 * a floor. Override rates via a local JSON config (see loadPricing).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

// ---------------------------------------------------------------------------
// Pricing ($/MTok, API-equivalent). cacheWrite = 5m-TTL rate (1.25x input).
// ---------------------------------------------------------------------------

export type Rates = { input: number; output: number; cacheWrite: number; cacheRead: number };

export const FALLBACK_RATES: Rates = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };

export const DEFAULT_PRICING: Record<string, Rates> = {
  // Calibrated 2026-08-29 against 81 Claude Code runs whose own cost_usd was known
  // (least squares, cache write 1.25× / read 0.1× of input): in ≈ $15.5, out ≈ $49.
  "claude-fable-5": { input: 15, output: 50, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

/**
 * Load the pricing table, optionally merged with a local JSON override file:
 *   { "model-id": { "input": .., "output": .., "cacheWrite": .., "cacheRead": .. },
 *     "fallback": { ... } }   ($/MTok; partial objects merge over defaults)
 */
export function loadPricing(overridePath?: string): {
  table: Record<string, Rates>;
  fallback: Rates;
} {
  const table = { ...DEFAULT_PRICING };
  let fallback = FALLBACK_RATES;
  if (overridePath && fs.existsSync(overridePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(overridePath, "utf8")) as Record<string, Rates>;
      for (const [model, rates] of Object.entries(raw)) {
        if (model === "fallback") fallback = { ...fallback, ...rates };
        else table[model] = { ...(table[model] ?? fallback), ...rates };
      }
    } catch (e) {
      console.error(`[meter] ignoring malformed ${overridePath}: ${(e as Error).message}`);
    }
  }
  return { table, fallback };
}

/** Rates for a model id: exact match, then family match, then labeled fallback. */
export function ratesFor(
  model: string,
  pricing: { table: Record<string, Rates>; fallback: Rates },
): { rates: Rates; isFallback: boolean } {
  if (pricing.table[model]) return { rates: pricing.table[model], isFallback: false };
  for (const family of ["fable", "opus", "sonnet", "haiku"]) {
    if (model.includes(family)) {
      const rep = Object.keys(pricing.table).find((id) => id.includes(family));
      if (rep) return { rates: pricing.table[rep], isFallback: false };
    }
  }
  return { rates: pricing.fallback, isFallback: true };
}

export type Usage = { input: number; output: number; cacheCreation: number; cacheRead: number };

export const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });

export function addUsage(into: Usage, u: Usage): void {
  into.input += u.input;
  into.output += u.output;
  into.cacheCreation += u.cacheCreation;
  into.cacheRead += u.cacheRead;
}

export function costUsd(u: Usage, r: Rates): number {
  return (
    (u.input * r.input + u.output * r.output + u.cacheCreation * r.cacheWrite + u.cacheRead * r.cacheRead) / 1e6
  );
}

// ---------------------------------------------------------------------------
// Transcript parsing (metadata only; message content is never touched)
// ---------------------------------------------------------------------------

/** Local-timezone YYYY-MM-DD for an ISO timestamp (your day, not UTC's). */
const dayFmt = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
export function dateKey(iso: string): string {
  return dayFmt.format(new Date(iso));
}

export type DayUsage = {
  models: Map<string, Usage>;
  assistantMessages: number;
  userMessages: number;
};

export type SessionMeta = {
  sessionId: string;
  projectDir: string; // encoded folder basename, e.g. -Users-you-Desktop-someproj
  cwd: string | null; // BASENAME only, for privacy
  start: string | null;
  end: string | null;
  days: Map<string, DayUsage>;
};

function newSession(sessionId: string, projectDir: string): SessionMeta {
  return { sessionId, projectDir, cwd: null, start: null, end: null, days: new Map() };
}

function dayOf(s: SessionMeta, key: string): DayUsage {
  let d = s.days.get(key);
  if (!d) {
    d = { models: new Map(), assistantMessages: 0, userMessages: 0 };
    s.days.set(key, d);
  }
  return d;
}

/**
 * Fold one transcript file (main session or subagent) into a session record.
 * Reads each JSONL line, keeps ONLY: type, timestamp, cwd basename, model id,
 * usage token counts. Content fields are never dereferenced.
 */
export function parseTranscriptFile(file: string, session: SessionMeta): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return; // unreadable file: skip, never fail the whole run
  }
  const seenMessages = new Map<string, { day: DayUsage; model: string; usage: Usage }>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // malformed line (partial write): skip
    }
    const type = o.type;
    if (type !== "user" && type !== "assistant") continue;
    const ts = typeof o.timestamp === "string" ? o.timestamp : null;
    if (!ts) continue;
    if (!session.start || ts < session.start) session.start = ts;
    if (!session.end || ts > session.end) session.end = ts;
    if (!session.cwd && typeof o.cwd === "string" && o.cwd) session.cwd = path.basename(o.cwd);
    const day = dayOf(session, dateKey(ts));
    if (type === "user") {
      if (!o.isMeta) day.userMessages += 1;
      continue;
    }
    // assistant. Claude Code writes ONE LINE PER CONTENT BLOCK of a reply (text,
    // tool_use, …) and every line carries the same message id and the same usage —
    // the last line has the final output count. Summing every line overcounted by
    // 60–70% on real transcripts (measured 2026-08-29). Keep one usage per message
    // (id + requestId), last row wins; rows without an id count as their own message.
    const message = o.message as { id?: string; model?: string; usage?: Record<string, number> } | undefined;
    const model = message?.model;
    const usage = message?.usage;
    const key = message?.id ? `${message.id}|${typeof o.requestId === "string" ? o.requestId : ""}` : `row:${o.uuid ?? Math.random()}`;
    if (!seenMessages.has(key)) { day.assistantMessages += 1; }
    if (!model || model === "<synthetic>" || !usage) continue;
    const u: Usage = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheCreation: usage.cache_creation_input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
    };
    const prev = seenMessages.get(key);
    if (prev) {
      // Replace: subtract what an earlier row of this message contributed.
      const bucket = prev.day.models.get(prev.model);
      if (bucket) { bucket.input -= prev.usage.input; bucket.output -= prev.usage.output; bucket.cacheCreation -= prev.usage.cacheCreation; bucket.cacheRead -= prev.usage.cacheRead; }
    }
    seenMessages.set(key, { day, model, usage: u });
    let bucket = day.models.get(model);
    if (!bucket) {
      bucket = zeroUsage();
      day.models.set(model, bucket);
    }
    addUsage(bucket, u);
  }
}

function findJsonl(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findJsonl(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
}

/**
 * Scan ~/.claude/projects. Top-level files are sessions (<uuid>.jsonl); nested
 * files (e.g. <uuid>/subagents/agent-*.jsonl) fold into their parent session.
 * `sinceMs` skips files not modified since then (a transcript's mtime is >= its
 * last line's timestamp, so older files cannot contain in-range activity).
 */
export function scanProjects(root: string = PROJECTS_ROOT, sinceMs = 0): SessionMeta[] {
  const sessions = new Map<string, SessionMeta>();
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const pd of projectDirs) {
    if (!pd.isDirectory()) continue;
    const projectDir = pd.name; // already an encoded basename, no raw path
    const files: string[] = [];
    findJsonl(path.join(root, pd.name), files);
    for (const file of files) {
      try {
        if (sinceMs && fs.statSync(file).mtimeMs < sinceMs) continue;
      } catch {
        continue;
      }
      const rel = path.relative(path.join(root, pd.name), file);
      const parts = rel.split(path.sep);
      // top-level "<id>.jsonl" -> id; nested "<id>/subagents/..." -> id
      const sessionId = parts.length === 1 ? path.basename(parts[0], ".jsonl") : parts[0];
      const key = `${projectDir}/${sessionId}`;
      let s = sessions.get(key);
      if (!s) {
        s = newSession(sessionId, projectDir);
        sessions.set(key, s);
      }
      parseTranscriptFile(file, s);
    }
  }
  return [...sessions.values()];
}

// ---------------------------------------------------------------------------
// Daily report
// ---------------------------------------------------------------------------

export type ModelReport = Usage & { cost_usd: number; pricing_fallback?: true };

/** The encoded project folder name embeds the full path; reduce to a basename. */
export const encodedBasename = (enc: string): string => enc.split("-").filter(Boolean).pop() ?? enc;

export type SessionReport = {
  session_id: string;
  project: string; // repo BASENAME only (cwd basename, else last segment of encoded dir)
  session_start: string | null;
  session_end: string | null;
  duration_minutes: number | null;
  assistant_messages: number;
  user_messages: number;
  models: Record<string, ModelReport>;
  cost_usd: number;
};

export type DayReport = {
  date: string;
  generated_at: string;
  source: "claude-code-local-logs";
  note: string;
  session_count: number;
  sessions: SessionReport[];
  totals: Usage & {
    assistant_messages: number;
    user_messages: number;
    cost_usd: number;
    by_model: Record<string, ModelReport>;
  };
};

const round = (n: number, places = 6): number => Number(n.toFixed(places));

export function buildDayReport(
  date: string,
  sessions: SessionMeta[],
  pricing: { table: Record<string, Rates>; fallback: Rates },
  now: () => string = () => new Date().toISOString(),
): DayReport {
  const active = sessions
    .filter((s) => s.days.has(date))
    .sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));

  const totals = { ...zeroUsage(), assistant_messages: 0, user_messages: 0, cost_usd: 0 } as DayReport["totals"];
  totals.by_model = {};

  const sessionReports: SessionReport[] = active.map((s) => {
    const day = s.days.get(date)!;
    const models: Record<string, ModelReport> = {};
    let cost = 0;
    for (const [model, u] of [...day.models.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const { rates, isFallback } = ratesFor(model, pricing);
      const c = costUsd(u, rates);
      cost += c;
      models[model] = { ...u, cost_usd: round(c), ...(isFallback ? { pricing_fallback: true as const } : {}) };
      addUsage(totals, u);
      const agg = (totals.by_model[model] ??= { ...zeroUsage(), cost_usd: 0 });
      addUsage(agg, u);
      agg.cost_usd = round(agg.cost_usd + c);
      if (isFallback) agg.pricing_fallback = true;
    }
    totals.assistant_messages += day.assistantMessages;
    totals.user_messages += day.userMessages;
    totals.cost_usd += cost;
    const durationMin =
      s.start && s.end ? round((new Date(s.end).getTime() - new Date(s.start).getTime()) / 60000, 1) : null;
    return {
      session_id: s.sessionId,
      project: s.cwd ?? encodedBasename(s.projectDir),
      session_start: s.start,
      session_end: s.end,
      duration_minutes: durationMin,
      assistant_messages: day.assistantMessages,
      user_messages: day.userMessages,
      models,
      cost_usd: round(cost),
    };
  });

  totals.cost_usd = round(totals.cost_usd);
  return {
    date,
    generated_at: now(),
    source: "claude-code-local-logs",
    note: "Observed interactive Claude Code usage. Metadata only. cost_usd is API-equivalent (actual billing: subscription).",
    session_count: sessionReports.length,
    sessions: sessionReports,
    totals,
  };
}

export const fmtInt = (n: number): string => n.toLocaleString("en-US");
export const fmtUsd = (n: number): string => `$${n.toFixed(2)}`;

export function dayReportMarkdown(r: DayReport): string {
  const lines = [
    `# Claude Code sessions: ${r.date}`,
    "",
    r.note,
    "",
    `**${r.session_count} session(s)** · ${fmtInt(r.totals.input)} in / ${fmtInt(r.totals.output)} out / ${fmtInt(r.totals.cacheCreation)} cache-write / ${fmtInt(r.totals.cacheRead)} cache-read tokens · API-equivalent ${fmtUsd(r.totals.cost_usd)}`,
    "",
    "| Session | Project | Window | Msgs (user/asst) | Input | Output | Cache W | Cache R | API-eq $ |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const s of r.sessions) {
    const u = Object.values(s.models).reduce((acc, m) => (addUsage(acc, m), acc), zeroUsage());
    const window =
      s.session_start && s.session_end
        ? `${s.session_start.slice(11, 16)}-${s.session_end.slice(11, 16)}Z (${s.duration_minutes ?? "?"}m)`
        : "n/a";
    lines.push(
      `| \`${s.session_id.slice(0, 8)}\` | ${s.project} | ${window} | ${s.user_messages}/${s.assistant_messages} | ${fmtInt(u.input)} | ${fmtInt(u.output)} | ${fmtInt(u.cacheCreation)} | ${fmtInt(u.cacheRead)} | ${fmtUsd(s.cost_usd)} |`,
    );
  }
  lines.push("", "## By model", "", "| Model | Input | Output | Cache W | Cache R | API-eq $ |", "|---|---|---|---|---|---|");
  for (const [model, m] of Object.entries(r.totals.by_model)) {
    lines.push(
      `| ${model}${m.pricing_fallback ? " (fallback rate)" : ""} | ${fmtInt(m.input)} | ${fmtInt(m.output)} | ${fmtInt(m.cacheCreation)} | ${fmtInt(m.cacheRead)} | ${fmtUsd(m.cost_usd)} |`,
    );
  }
  return lines.join("\n") + "\n";
}

/** Rollup markdown built from the daily JSON files on disk (idempotent by design). */
export function buildSummaryMarkdown(ledgerDir: string, days = 30): string {
  const rows: DayReport[] = [];
  if (fs.existsSync(ledgerDir)) {
    for (const f of fs.readdirSync(ledgerDir).sort().reverse()) {
      const m = /^sessions-(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
      if (!m) continue;
      try {
        rows.push(JSON.parse(fs.readFileSync(path.join(ledgerDir, f), "utf8")) as DayReport);
      } catch {
        /* skip unreadable day file */
      }
      if (rows.length >= days) break;
    }
  }
  const grand = { ...zeroUsage(), sessions: 0, cost: 0 };
  const lines = [
    `# Claude Code session meter: last ${days} days`,
    "",
    "Observed interactive Claude Code usage (metadata only). Dollar figures are API-equivalent at standard rates; actual billing is the Claude subscription.",
    "",
    "| Date | Sessions | Input | Output | Cache write | Cache read | API-eq $ |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.date} | ${r.session_count} | ${fmtInt(r.totals.input)} | ${fmtInt(r.totals.output)} | ${fmtInt(r.totals.cacheCreation)} | ${fmtInt(r.totals.cacheRead)} | ${fmtUsd(r.totals.cost_usd)} |`,
    );
    grand.sessions += r.session_count;
    grand.cost += r.totals.cost_usd;
    addUsage(grand, r.totals);
  }
  lines.push(
    `| **Total** | **${grand.sessions}** | **${fmtInt(grand.input)}** | **${fmtInt(grand.output)}** | **${fmtInt(grand.cacheCreation)}** | **${fmtInt(grand.cacheRead)}** | **${fmtUsd(grand.cost)}** |`,
    "",
    `_Updated ${new Date().toISOString()} by cookbook-meter._`,
  );
  return lines.join("\n") + "\n";
}
