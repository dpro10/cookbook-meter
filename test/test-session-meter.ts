/**
 * Hermetic unit test for cookbook-meter (src/session-meter.ts).
 * Runs entirely against fabricated fixtures in test/fixtures/session-meter/
 * (no real logs, no network).
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import path from "node:path";
import {
  DEFAULT_PRICING,
  FALLBACK_RATES,
  buildDayReport,
  buildSummaryMarkdown,
  costUsd,
  dateKey,
  dayReportMarkdown,
  encodedBasename,
  loadPricing,
  ratesFor,
  scanProjects,
  zeroUsage,
} from "../src/session-meter";
import fs from "node:fs";
import os from "node:os";

const FIXTURES = path.resolve(path.dirname(new URL(import.meta.url).pathname), "fixtures", "session-meter");
const pricing = { table: DEFAULT_PRICING, fallback: FALLBACK_RATES };

// Fixture timestamps are midday UTC so the local calendar date is stable
// across timezones; expected keys are computed with the same dateKey helper.
const D1 = dateKey("2026-07-01T12:00:00.000Z");
const D2 = dateKey("2026-07-02T12:00:00.000Z");

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL  ${name}\n      ${(e as Error).message}`);
  }
}

// ---- pricing ----
check("cost math: fable-5 rates", () => {
  const u = { input: 100, output: 200, cacheCreation: 1000, cacheRead: 5000 };
  // (100*10 + 200*50 + 1000*12.5 + 5000*1) / 1e6 = 0.0285
  assert.ok(Math.abs(costUsd(u, DEFAULT_PRICING["claude-fable-5"]) - 0.0285) < 1e-9);
});

check("ratesFor: exact, family, fallback", () => {
  assert.equal(ratesFor("claude-sonnet-5", pricing).isFallback, false);
  const fam = ratesFor("claude-opus-9-9", pricing); // unseen opus id -> family rate
  assert.equal(fam.isFallback, false);
  assert.equal(fam.rates.input, 5);
  const unk = ratesFor("mystery-model-9", pricing);
  assert.equal(unk.isFallback, true);
  assert.deepEqual(unk.rates, FALLBACK_RATES);
});

check("loadPricing: local JSON override merges over defaults", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meter-pricing-"));
  try {
    const p = path.join(tmp, "meter-pricing.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        "claude-fable-5": { input: 20 },
        "my-custom-model": { input: 1, output: 2, cacheWrite: 1.25, cacheRead: 0.1 },
        fallback: { output: 99 },
      }),
    );
    const loaded = loadPricing(p);
    assert.equal(loaded.table["claude-fable-5"].input, 20); // overridden
    assert.equal(loaded.table["claude-fable-5"].output, 50); // default preserved
    assert.equal(loaded.table["my-custom-model"].output, 2); // new model added
    assert.equal(loaded.fallback.output, 99); // fallback merged
    assert.equal(loaded.fallback.input, FALLBACK_RATES.input);
    // no override path: pure defaults
    assert.deepEqual(loadPricing(undefined).table, DEFAULT_PRICING);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- scanning / parsing ----
const sessions = scanProjects(FIXTURES, 0);

check("scan groups files into 2 sessions (subagent folds into parent)", () => {
  assert.equal(sessions.length, 2);
  const ids = sessions.map((s) => s.sessionId).sort();
  assert.deepEqual(ids, ["11111111-aaaa-bbbb-cccc-000000000001", "22222222-aaaa-bbbb-cccc-000000000002"]);
});

const s1 = sessions.find((s) => s.sessionId.startsWith("11111111"))!;
const s2 = sessions.find((s) => s.sessionId.startsWith("22222222"))!;

check("session 1: per-day token aggregation and message counts", () => {
  const d1 = s1.days.get(D1)!;
  assert.deepEqual(d1.models.get("claude-fable-5"), { input: 100, output: 200, cacheCreation: 1000, cacheRead: 5000 });
  assert.equal(d1.models.has("<synthetic>"), false); // synthetic model carries no priced usage
  assert.equal(d1.userMessages, 1); // isMeta user line excluded
  assert.equal(d1.assistantMessages, 2); // real + synthetic
  const d2 = s1.days.get(D2)!;
  assert.deepEqual(d2.models.get("mystery-model-9"), { input: 10, output: 20, cacheCreation: 0, cacheRead: 0 });
  assert.equal(s1.start, "2026-07-01T12:00:00.000Z");
  assert.equal(s1.end, "2026-07-02T12:00:00.000Z");
});

check("session 2: subagent usage folds into the parent session", () => {
  const d1 = s2.days.get(D1)!;
  // main 1000/500/0/2000 + subagent 50/60/70/80
  assert.deepEqual(d1.models.get("claude-sonnet-5"), { input: 1050, output: 560, cacheCreation: 70, cacheRead: 2080 });
  assert.equal(d1.assistantMessages, 2);
  assert.equal(d1.userMessages, 1);
});

// ---- day report ----
const r1 = buildDayReport(D1, sessions, pricing, () => "2026-07-03T00:00:00.000Z");
const r2 = buildDayReport(D2, sessions, pricing, () => "2026-07-03T00:00:00.000Z");

check("day report D1: sessions active that day, totals, cost", () => {
  assert.equal(r1.session_count, 2);
  assert.equal(r1.totals.input, 1150);
  assert.equal(r1.totals.output, 760);
  assert.equal(r1.totals.cacheCreation, 1070);
  assert.equal(r1.totals.cacheRead, 7080);
  assert.equal(r1.totals.user_messages, 2);
  assert.equal(r1.totals.assistant_messages, 4);
  // fable 0.0285 + sonnet (1050*3+560*15+70*3.75+2080*0.3)/1e6 = 0.0124365
  assert.ok(Math.abs(r1.totals.cost_usd - 0.0409) < 5e-4, `got ${r1.totals.cost_usd}`);
});

check("day report D2: only session 1 active; unknown model flagged fallback", () => {
  assert.equal(r2.session_count, 1);
  const m = r2.sessions[0].models["mystery-model-9"];
  assert.equal(m.pricing_fallback, true);
  assert.ok(Math.abs(m.cost_usd - 0.00055) < 1e-6); // (10*5 + 20*25)/1e6
  assert.equal(r2.totals.by_model["mystery-model-9"].pricing_fallback, true);
});

check("privacy: no content or full paths leak into JSON or markdown output", () => {
  for (const out of [JSON.stringify(r1), JSON.stringify(r2), dayReportMarkdown(r1), dayReportMarkdown(r2)]) {
    assert.ok(!out.includes("FAKE_"), "fixture content leaked into output");
    assert.ok(!out.includes("/Users/testuser"), "full cwd path leaked into output");
    assert.ok(!out.includes("-Users-testuser"), "encoded full path leaked into output");
  }
  assert.equal(r1.sessions[0].project, "fakeproj"); // basename only
});

check("encodedBasename reduces encoded project dirs", () => {
  assert.equal(encodedBasename("-Users-testuser-fakeproj"), "fakeproj");
  assert.equal(encodedBasename("-Users-diegoprozzi"), "diegoprozzi");
});

check("zeroUsage is fresh per call", () => {
  const a = zeroUsage();
  a.input = 99;
  assert.equal(zeroUsage().input, 0);
});

// ---- summary rollup (from a temp ledger dir, still hermetic) ----
check("summary.md rolls up daily JSON files", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meter-test-"));
  try {
    fs.writeFileSync(path.join(tmp, `sessions-${D1}.json`), JSON.stringify(r1));
    fs.writeFileSync(path.join(tmp, `sessions-${D2}.json`), JSON.stringify(r2));
    const md = buildSummaryMarkdown(tmp, 30);
    assert.ok(md.includes(`| ${D1} | 2 |`), "D1 row missing");
    assert.ok(md.includes(`| ${D2} | 1 |`), "D2 row missing");
    assert.ok(md.includes("**Total**"), "total row missing");
    assert.ok(!md.includes("FAKE_"), "content leaked into summary");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("\nall session-meter tests passed");
