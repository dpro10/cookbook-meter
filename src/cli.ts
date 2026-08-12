/**
 * cookbook-meter CLI.
 *
 * Default: scan ~/.claude/projects and print a 30-day summary table to stdout
 * (sessions, tokens by class, API-equivalent dollars, busiest days).
 *
 * Flags:
 *   --days N          window size in days (default 30)
 *   --ledger [dir]    also write per-day JSON ledger files + summary.md
 *                     (default dir: ./ledger)
 *   --pricing FILE    JSON pricing override (default: ./meter-pricing.json if present)
 *   --root DIR        transcripts root (default: ~/.claude/projects)
 *   --help            usage
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildDayReport,
  buildSummaryMarkdown,
  dateKey,
  fmtInt,
  fmtUsd,
  loadPricing,
  scanProjects,
  zeroUsage,
  addUsage,
  PROJECTS_ROOT,
  type DayReport,
} from "./session-meter";

const USAGE = `cookbook-meter: metadata-only usage meter for local Claude Code sessions

Usage: npx cookbook-meter [options]

Options:
  --days N          window size in days (default 30)
  --ledger [dir]    also write sessions-YYYY-MM-DD.json + summary.md (default dir: ./ledger)
  --pricing FILE    JSON pricing override ($/MTok; default: ./meter-pricing.json if present)
  --root DIR        transcripts root (default: ~/.claude/projects)
  --help            show this help

Privacy: outputs contain only counts, model ids, timestamps, durations,
repo basenames, and dollars. Message content is never read into any output.
`;

type Args = { days: number; ledgerDir: string | null; pricingPath?: string; root: string };

function parseArgs(argv: string[]): Args {
  const args: Args = { days: 30, ledgerDir: null, root: PROJECTS_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (a === "--days") {
      args.days = Math.max(1, Number(argv[++i]) || 30);
    } else if (a === "--ledger") {
      const next = argv[i + 1];
      args.ledgerDir = next && !next.startsWith("--") ? argv[++i] : "./ledger";
    } else if (a === "--pricing") {
      args.pricingPath = argv[++i];
    } else if (a === "--root") {
      args.root = argv[++i] ?? PROJECTS_ROOT;
    } else {
      console.error(`unknown option: ${a}\n`);
      process.stderr.write(USAGE);
      process.exit(2);
    }
  }
  if (!args.pricingPath && fs.existsSync("meter-pricing.json")) args.pricingPath = "meter-pricing.json";
  return args;
}

function targetDates(days: number): string[] {
  const out: string[] = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    out.push(dateKey(new Date(now - i * 86_400_000).toISOString()));
  }
  return [...new Set(out)];
}

/** Right-pad or left-pad columns into an aligned plain-text table. */
function renderTable(header: string[], rows: string[][], rightAlign: boolean[]): string {
  const all = [header, ...rows];
  const widths = header.map((_, c) => Math.max(...all.map((r) => r[c].length)));
  const line = (r: string[]) =>
    r.map((cell, c) => (rightAlign[c] ? cell.padStart(widths[c]) : cell.padEnd(widths[c]))).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [line(header), sep, ...rows.map(line)].join("\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dates = targetDates(args.days);
  const pricing = loadPricing(args.pricingPath);
  if (args.pricingPath) console.error(`[meter] pricing override: ${args.pricingPath}`);

  const sinceMs = new Date(`${dates[0]}T00:00:00`).getTime() - 86_400_000; // 1-day fudge for TZ edges
  const sessions = scanProjects(args.root, sinceMs);

  const reports: DayReport[] = [];
  for (const date of dates) {
    const r = buildDayReport(date, sessions, pricing);
    if (r.session_count > 0) reports.push(r);
  }

  const grand = { ...zeroUsage(), sessions: 0, cost: 0, userMessages: 0, assistantMessages: 0 };
  const rows: string[][] = [];
  for (const r of reports) {
    rows.push([
      r.date,
      String(r.session_count),
      fmtInt(r.totals.input),
      fmtInt(r.totals.output),
      fmtInt(r.totals.cacheCreation),
      fmtInt(r.totals.cacheRead),
      fmtUsd(r.totals.cost_usd),
    ]);
    grand.sessions += r.session_count;
    grand.cost += r.totals.cost_usd;
    grand.userMessages += r.totals.user_messages;
    grand.assistantMessages += r.totals.assistant_messages;
    addUsage(grand, r.totals);
  }
  rows.push([
    "Total",
    String(grand.sessions),
    fmtInt(grand.input),
    fmtInt(grand.output),
    fmtInt(grand.cacheCreation),
    fmtInt(grand.cacheRead),
    fmtUsd(grand.cost),
  ]);

  const uniqueSessions = new Set(
    sessions.filter((s) => dates.some((d) => s.days.has(d))).map((s) => `${s.projectDir}/${s.sessionId}`),
  ).size;
  const totalTokens = grand.input + grand.output + grand.cacheCreation + grand.cacheRead;

  console.log(`cookbook-meter: last ${args.days} days of local Claude Code sessions`);
  console.log(`source: ${args.root} (metadata only; message content is never read)\n`);

  if (reports.length === 0) {
    console.log("No sessions found in this window.");
    return;
  }

  console.log(
    renderTable(
      ["Date", "Sessions", "Input", "Output", "Cache write", "Cache read", "API-eq $"],
      rows,
      [false, true, true, true, true, true, true],
    ),
  );

  console.log(
    `\n${uniqueSessions} unique session(s) · ${fmtInt(totalTokens)} tokens · ${fmtInt(grand.userMessages)} user / ${fmtInt(grand.assistantMessages)} assistant messages · API-equivalent ${fmtUsd(grand.cost)}`,
  );

  const busiest = [...reports].sort((a, b) => b.totals.cost_usd - a.totals.cost_usd).slice(0, 3);
  console.log("\nBusiest days (API-eq $):");
  for (const r of busiest) {
    console.log(`  ${r.date}  ${fmtUsd(r.totals.cost_usd).padStart(10)}  (${r.session_count} session(s))`);
  }

  console.log(
    "\nDollar figures are API-equivalent at standard rates; actual billing is your Claude subscription.",
  );

  if (args.ledgerDir) {
    const dir = path.resolve(args.ledgerDir);
    fs.mkdirSync(dir, { recursive: true });
    for (const r of reports) {
      fs.writeFileSync(path.join(dir, `sessions-${r.date}.json`), JSON.stringify(r, null, 2) + "\n");
    }
    fs.writeFileSync(path.join(dir, "summary.md"), buildSummaryMarkdown(dir, args.days));
    console.log(`\n[meter] ledger written: ${reports.length} day file(s) + summary.md in ${dir}`);
  }
}

main();
