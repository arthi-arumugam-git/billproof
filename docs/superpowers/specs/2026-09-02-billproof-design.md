# billproof — design spec

Date: 2026-09-02. Owner: Arthi Arumugam. Status: direction approved by Arthi ("we are doing this for sure"); spec written by Claude; build starts immediately.

## One sentence

`npx billproof` reads the Claude Code transcripts already on your disk, prices every request the way Anthropic actually bills it, and tells you which turns cost the money and why.

## Why this and not something else

Evidence with URLs lives in `D:\money-scout\research\llm-cost-niche.md` and `passive-income-reality.md`.

- 20 competitors checked (Helicone $79/mo through Braintrust $249/mo); none reconciles metered usage against the provider's bill.
- 14 projects shipped cache/streaming cost-accounting bugs in 12 months; measured errors of +8.5%, 2.83x, 6.7x, $50 vs $446.
- Loudest demand is "explain my Claude Code bill / usage window": r/ClaudeAI posts at 125 and 32 upvotes, an HN thread at 942 points where Claude Code's lead confirms idle-cache misses cause "outsized token costs".
- Indie comparables sell at $29/mo, $9/mo, $199 lifetime, 299 EUR one-off; all are dashboards, none does correctness.
- Arthi's credibility: 24 merged upstream fixes in exactly this defect class.
- Developer tools are the only product type in the research with verified solo five-figure MRR and a channel that does not need an audience.

## What the local data proves

Measured 2026-09-02 on this machine: 867 transcripts, 107,736 assistant lines.

1. One API response is written as several JSONL lines (one per content block), each repeating the same `usage`. 59,135 lines share a `requestId` with another line. Any tool that sums lines over-counts. Dedupe key: `message.id`, fallback `requestId`.
2. 54,205 turns carry `cache_creation.ephemeral_1h_input_tokens` (2x base) and 53,373 carry 5m writes (1.25x). Pricing all writes at 1.25x under-counts.
3. `usage.iterations` can carry a `fallback_message` iteration with its own `model` (server-side refusal fallback). Each iteration is priced at its own model.
4. `<synthetic>` model lines (`isApiErrorMessage`) carry no billable usage; skip.
5. Every line carries `isSidechain`, `agentId`, `attributionSkill`, `attributionMcpServer`, `attributionMcpTool`, `effort`, `entrypoint`, `gitBranch`, `cwd`. Attribution by skill, MCP server, subagent and project is free data.
6. 50,165 turns exceed 200k context; Claude 4.6+ bills the full 1M window at standard rates (official pricing page, "Long context pricing"). Pre-4.6 1M-context models carried a premium; the table keeps a per-model long-context multiplier.

## Pricing engine rules

Source: platform.claude.com/docs/en/about-claude/pricing, fetched 2026-09-02, saved at `D:\money-scout\research\raw\build-anthropic-pricing.md`.

Per model: base input, 5m write = 1.25x, 1h write = 2x, cache read = 0.1x (0.025x on Fable 5.1 / Mythos 5.1), output. Fast mode (`usage.speed == "fast"`, Opus 5 / 4.8 only): 2x on every category. `inference_geo == "us"` on 4.6+: 1.1x on every category. Batch: 0.5x (not seen in Claude Code). Prices are a dated table; each model row carries `effective_from` so re-pricing old months uses the price in force then.

Cost of a message = sum over iterations (or the single usage) of:

```
input x base
+ cache_5m x 1.25 x base
+ cache_1h x 2 x base
+ cache_read x read_rate
+ output x out
then x fast x geo
```

Where `cache_creation.ephemeral_*` is absent (older Claude Code versions), all `cache_creation_input_tokens` are priced as 5m and the turn is flagged `tier-unknown`.

## Commands

### `billproof` (alias `scan`), free

Reads `~/.claude/projects/**/*.jsonl` (or `--dir`). Output: true cost by day, by model, by project, top sessions; plus the "naive delta" panel showing what three common wrong methods would have reported (all-writes-5m, cache-blind, line-summed) and how far each is off. Flags: `--since 7d|30d|YYYY-MM-DD`, `--json`, `--by day|model|project|skill|mcp|agent`.

### `billproof receipt [session-id | --last N | --today]`, paid

Per-turn line items with a root-cause label from a fixed taxonomy, each with a dollar attribution and the evidence fields that fired the rule.

| label | rule | attributed dollars |
|---|---|---|
| cache-expired | gap since previous request in session > TTL of previous write, and this turn's cache_creation >= 50% of previous (read + creation) | creation x (write rate - read rate) |
| one-hour-write | ephemeral_1h > 0 | 1h tokens x (2 - 1.25) x base |
| model-switch | model differs from previous turn's model (cache is model-scoped) | creation x (write - read) |
| context-heavy | read + creation + input >= 100k | reads x read rate |
| output-heavy | output >= 8k | output x out rate |
| uncached-paste | input >= 20k | input x base |
| subagent | isSidechain or agentId set | full turn cost, grouped |
| fast-mode | speed == fast | 50% of turn cost |
| us-only-geo | inference_geo == us | turn cost x (1 - 1/1.1) |
| fallback | iterations has fallback_message | declining iteration's cost |

`--html out.html` writes a self-contained report. `--json` for machines.

### `billproof reconcile`, paid, v0.2

Pulls `/v1/organizations/usage_report/messages` and `/v1/organizations/cost_report` with an Admin key and diffs against local totals per day and model with the same taxonomy. Out of scope for v0.1 except the interface stub; the Admin API is org-only and daily-bucketed.

### `billproof activate <key>` and `billproof license`

Polar license validation (`POST https://api.polar.sh/v1/customer-portal/license-keys/validate`, org id baked in) or an offline Ed25519-signed key (`bp1_...`, public key baked in) for keys issued by hand before the Polar account exists. Stored at `~/.billproof/license.json`; re-validated weekly; 30-day offline grace. Paid commands without a license print the free summary and a one-line upgrade pointer, never a nag.

## Non-goals for v0.1

OpenAI, Codex and OpenCode transcripts (v0.3). Subscription-limit percentages (not in transcripts; we show cost-equivalent at API list price and say so). Any network call except license validation. Any upload of transcript content, ever.

## Architecture

TypeScript, Node >= 20, ESM, zero runtime dependencies.

```
src/
  cli.ts              arg parsing, command dispatch, exit codes
  discover.ts         find transcript files, stream lines, yield raw records
  parse.ts            raw record -> Turn {id, sessionId, ts, model, usage, iterations, attribution, sidechain}
  dedupe.ts           collapse lines to one Turn per message.id (fallback requestId)
  pricing/table.ts    dated price table + lookup(model, date)
  pricing/price.ts    priceTurn(turn) -> Cost {input, write5m, write1h, read, output, total, multipliers, flags}
  analyze/scan.ts     aggregations + naive-delta panel
  analyze/receipt.ts  root-cause rules over a session's ordered turns
  report/terminal.ts, report/json.ts, report/html.ts
  license.ts          activate / check
tests/                vitest; fixtures are anonymised real records (usage, ids, timestamps only)
```

Every rule and every price row is a unit test. A golden test prices a fixture directory and asserts totals to the cent. A regression test asserts that summing lines without dedupe over-counts the fixture (documents defect class 1).

## Distribution

- npm `billproof` (`npx billproof`), GitHub `arthi-arumugam-git/billproof`. MIT. The license gate is a courtesy gate, not DRM.
- Landing page on Vercel (`billproof.vercel.app` until a domain exists): problem, live sample output, price ($29 lifetime for receipt), FAQ, author proof.
- Checkout: Polar (merchant of record, accepts Indian individuals, handles EU VAT); PayPal payment link as the day-one fallback with hand-issued keys.
- Launch: Show HN, r/ClaudeAI, r/ClaudeCode, X. Drafts in `docs/launch/`, posted by Arthi only.

## Success criteria

- `npx billproof` on this machine finishes under 10 s over 867 files and matches a hand-computed total for one session to the cent.
- All root-cause rules fire on at least one real session here and on a synthetic fixture.
- A stranger can buy, activate and run `receipt` with no human involved.
