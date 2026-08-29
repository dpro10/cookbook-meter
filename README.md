# cookbook-meter

We ran this on one founder's month: 46 sessions, 5.36B tokens, $7,377 API-equivalent on a $200 subscription.

cookbook-meter reads the session transcripts Claude Code already writes to your disk and answers one question: what is your subscription actually doing for you? It prints sessions per day, tokens by class, and what the same usage would have cost at standard API rates. Nothing leaves your machine.

## Quickstart

```
npx cookbook-meter
```

That prints a 30-day summary table: sessions per day, input / output / cache-write / cache-read tokens, API-equivalent dollars, and your busiest days.

```
npx cookbook-meter --days 14          # different window
npx cookbook-meter --ledger           # also write per-day JSON files to ./ledger
npx cookbook-meter --ledger ./out     # choose the ledger directory
npx cookbook-meter --pricing my.json  # override the pricing table
```

Requires Node 20 or newer.

## Counting rules (v0.2.0)

- **One usage per message.** Claude Code writes one transcript line per content block of a reply (text, tool call, …); every line repeats the same message id and usage, and the last line carries the final output count. v0.1.0 summed every line, which overcounted real transcripts by 60–70%. v0.2.0 keeps one usage per message (last row wins).
- **Fable 5 rates calibrated.** Checked against 81 real Claude Code runs whose own cost report was known: the API-equivalent rate is about $15/M input and $50/M output (v0.1.0 assumed $10/$50). Sonnet 5 and Opus 5 rates are within ±20% of the same check; the table is still an estimate, not a bill.

## What it measures, and how

- It scans `~/.claude/projects/**/*.jsonl`, the local transcripts Claude Code keeps for every session. Only metadata is read: timestamps, model ids, token counts, message counts, and the basename of the working directory.
- Subagent transcripts (`<session-id>/subagents/*.jsonl`) fold into their parent session, so a session's numbers include the work done by the agents it spawned.
- Tokens are counted in four classes: input, output, cache write, and cache read. Cache reads usually dominate the raw count and are also the cheapest class, which is why the dollar figure is much smaller than the token count alone would suggest.
- Dollars are API-equivalent: what the same tokens would have cost at standard per-model API rates. Your actual bill is your subscription. The number exists for the comparison.
- Pricing comes from a built-in per-model table in dollars per million tokens, with family matching for unseen model ids and a labeled fallback rate for unknown models. Cache writes are priced at the 5-minute-TTL rate (1.25x input); Claude Code also uses 1-hour caching (2x input), so the cache-write figure is a floor.

To override rates, pass `--pricing file.json` or drop a `meter-pricing.json` in the directory you run from:

```json
{
  "claude-fable-5": { "input": 10, "output": 50, "cacheWrite": 12.5, "cacheRead": 1 },
  "fallback": { "input": 5, "output": 25 }
}
```

Partial objects merge over the defaults, so you can override a single rate.

## Privacy

This is a hard rule, not a preference: outputs contain only counts, model ids, timestamps, durations, repo basenames, and dollars. Prompt and response content is never read into any output structure, and full filesystem paths never appear (the working directory is reduced to its basename). The test suite includes fixtures with sentinel content and asserts none of it leaks into any JSON or markdown output.

There is no network code in this package. It reads local files and prints to stdout; with `--ledger` it also writes JSON files to a local directory you choose. The hosted version of this meter, inside Cookbook, files these same daily summaries into a team ledger; this open-source version stops at your disk.

## Ledger files

With `--ledger`, each active day gets a `sessions-YYYY-MM-DD.json` file containing per-session detail (session id, project basename, start/end, duration, message counts, per-model token counts and cost) plus day totals, and a `summary.md` rollup table covers the whole window. The files are stable and idempotent: re-running produces the same content for past days, so you can commit them, sync them, or feed them to whatever tracks your team's work.

## Acknowledgments

[ccusage](https://github.com/ryoppippi/ccusage) is prior art for reading coding-agent logs and reporting cost, and it deserves the credit for proving people want this number. It is also broader than this tool: it covers 16+ coding CLIs with weekly, monthly, and billing-block views, and if you want wide-angle usage reports you should use it. cookbook-meter is narrower on purpose: it is the intake end of a team ledger. The differences: subagent transcripts fold into their parent sessions so a session's cost includes the agents it spawned, each day produces a stable, idempotent ledger file designed to be kept and committed rather than exported on demand, and the framing is the value of your subscription (what this month of work would have cost at API rates) rather than spend tracking.

## Why we built this

[cookbook.team](https://cookbook.team) is a shared workspace where teams and their AI agents work as one, and every task files a receipt. This meter is the single-player taste of the ledger.

MIT, copyright Diego Prozzi.
