# billproof

**Prove your AI bill.** `billproof` reads the Claude Code, Codex and Gemini CLI transcripts already on your disk, prices every request the way the provider actually bills it, shows which turns cost the money and why, and reconciles an organisation's Anthropic invoice against its own records.

```
npx billproof
```

No account, no upload, no API key. Nothing leaves your machine.

## Why a separate tool

Claude Code's transcripts carry the exact `usage` object Anthropic billed, but three things make naive counters wrong, and every one of them was measured on a real machine before this tool was written:

1. **One response is several lines.** Claude Code writes one JSONL line per content block, each repeating the full `usage`. A message with thinking, text and a tool call is counted three times by anything that sums lines. On the corpus this was written against, line-summing reported **+121%**.
2. **Two cache tiers, two prices.** A 5-minute cache write costs 1.25x base input; a 1-hour write costs 2x. More than half of all turns on that corpus used the 1-hour tier. Pricing everything at 1.25x under-reports.
3. **Cache reads are not free and not full price.** They are 0.1x base (0.025x on Claude Fable 5.1). Ignore them and you under-report by ~90%; price them as input and you over-report by ~670%.

`billproof` dedupes by `message.id`, prices each tier at its own rate, prices server-side fallback iterations at their own model, applies the fast-mode and US-only-inference multipliers, and flags anything it could not price with certainty instead of guessing.

## What you get

Sources: Claude Code (`~/.claude/projects`), Codex (`~/.codex/sessions`) and Gemini CLI (`~/.gemini/tmp`), all read by default; pick one with `--source claude|codex|gemini`. OpenAI reports `cached_input_tokens` inside `input_tokens` and Gemini bills `thoughts` as output; both are normalised to one convention so a single pricing rule applies, and the naive panel shows what the raw numbers would have said.

### `billproof` (free)

```
True cost at Anthropic list price: $12,568.91
category                tokens       cost  share
uncached input            497k      $3.39   0.0%
cache write 5m (1.25x)   90.3M    $666.11   5.3%
cache write 1h (2x)     120.5M  $1,458.37  11.6%
cache read (0.1x)       16.00B  $9,366.17  74.5%
output                   35.3M  $1,074.87   8.6%

What a naive counter would have told you
method             reports    error
line-summed     $27,773.46  +121.0%
all-writes-5m   $12,020.86    -4.4%
cache-as-input  $96,481.71  +667.6%
cache-blind      $1,078.25   -91.4%
```

Group with `--by day|model|project|skill|mcp|agent|session`. Window with `--since 7d`. Machine output with `--json`.

### `billproof receipt <session>` (paid, $49 once)

Every turn of a session as a line item with a root cause and the dollars it explains:

| cause | meaning |
|---|---|
| cache-expired | idle past the cache TTL; the whole context was re-written at write price instead of read price |
| prefix-changed | context re-written inside the TTL with few reads: compaction, an edited system prompt or a changed tool list broke the cached prefix |
| one-hour-write | 1-hour cache writes cost 2x base, the 5-minute tier costs 1.25x |
| model-switch | caches are per model; switching re-writes the context |
| context-heavy | large context read on every turn |
| output-heavy | long output or thinking |
| uncached-paste | large uncached input, often a paste or image |
| subagent | work done by subagents, on their own cache lane |
| fast-mode | fast mode premium (2x) |
| us-only-geo | US-only inference premium (1.1x) |
| fallback | server-side fallback billed the declining model's partial output |

`--html receipt.html` writes a self-contained report you can share. `--all` lists every turn. `--json` for machines.

Buy at https://arthi-arumugam-git.github.io/billproof#price ($49 once), then `billproof activate <key>`. The key is emailed on checkout by a merchant of record, so EU and UK VAT is on your invoice. Keys are verified once, cached locally and re-checked weekly with a 30-day offline grace, and one licence covers a set number of machines. The source is open; the gate is a courtesy.

### `billproof reconcile --from --to` (Team, $199 once per organisation)

What the organisation was billed against what its own records say, day by day and model by model, with every difference labelled by the cause that best explains it:

| label | meaning |
|---|---|
| match | local records and the provider agree within 1% |
| local-missing | billed but not in local records: another machine, CI, an app, or a teammate |
| local-extra | in local records but not billed: a subscription plan, another org's key, or a UTC day boundary |
| token-drift | token totals differ by more than 1% |
| cache-split-drift | totals agree but the uncached / write / read split does not, or cache reads are counted twice (inclusive-input convention) |
| price-drift | tokens agree but the local dollars do not: the local rate for this model is wrong |
| billed-vs-priced | the cost report differs from usage x list price: discount, credits, batch or priority tier, or web search |
| unknown-model | no price row; both sides show $0 |

```
billproof reconcile --from 2026-08-01 --to 2026-08-31                    # local side: the transcripts on this machine
billproof reconcile --from 2026-08-01 --to 2026-08-31 --local rows.json  # local side: your own metering, one row per day and model
```

The provider side is Anthropic's Admin API, `usage_report/messages` and `cost_report`, read with `ANTHROPIC_ADMIN_KEY` (an Admin key; organisation accounts only). `rows.json` is `[{day, model, uncached, write5m, write1h, read, output, usd?}]`. `usd` is what your metering says the day cost; when it is present, a matching token count with a different dollar figure is labelled `price-drift`, which is the defect this tool exists for. `--json` for machines.

## On subscription plans

Claude Pro and Max do not bill per token. `billproof` shows what the same requests would cost at API list price, which is also the best available proxy for how fast a turn consumes a usage window. The tool says so in its output rather than pretending otherwise.

## Prices

From https://platform.claude.com/docs/en/about-claude/pricing as fetched on 2026-09-02, encoded in `src/pricing/table.ts` with the fetch date. Legacy models not on that page are kept for old transcripts and flagged `price-unverified` whenever used. When Anthropic changes a price, the table gets a new dated row; old months keep the price in force at the time.

## Development

```
npm install
npm test          # vitest; fixtures are anonymised real transcripts (usage, ids, timestamps; no content)
npm run dev -- --by model
```

Every pricing rule and every root-cause rule is a unit test. A regression test proves that summing lines over-counts the fixture.

## Author

Arthi Arumugam. 24 merged upstream fixes in LLM cost and token accounting across inspect_evals (UK AISI), TruLens (Snowflake), lm-evaluation-harness, Pydantic Logfire and genai-prices, Mistral, LiveKit, Pipecat, deepset, Roboflow and others; most of them the same defect this tool exists to catch: a number comes out wrong and nothing raises.

MIT.
