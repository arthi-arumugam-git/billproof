# Launch posts

Drafts only. Arthi posts these herself, one per venue, after `npm publish` and after the landing page and repo are live. Each one leads with a measured number from her own machine, not a claim. Replace numbers with the current `npx billproof` output on the day.

## Show HN

**Title:** Show HN: billproof – price your Claude Code transcripts the way Anthropic actually bills them

**Body:**

I spent the last few months fixing the same bug in a dozen LLM tooling projects (Pipecat, LiveKit, TruLens, inspect_evals, Logfire, Mistral's client and others): a token or cost number comes out wrong and nothing raises. Most were prompt-cache accounting, which is now the majority of every Claude bill.

So I wrote a small CLI that reads the Claude Code transcripts already on your disk and prices every request the way the pricing page says, then shows what the common wrong methods would have reported.

On my machine, five weeks of Claude Code:

- true cost at list price: $12,573
- sum every transcript line (one line per content block, each repeats the usage): $27,773, +121%
- price every cache write at the 5-minute rate: −4.4% (54k of my turns were 1-hour writes at 2x)
- ignore cache tokens: $1,078, −91%

74.5% of the true number is cache reads at 0.1x. That's the thing most counters get wrong in one direction or the other.

`npx billproof` is free and local; nothing leaves the machine. The paid part ($29 once) is a per-turn receipt that labels why a turn cost what it did: idle past the cache TTL, a prompt prefix that changed inside the TTL (compaction, edited system prompt), 1-hour tier premium, subagents on their own cache lane, fast mode, US-only routing, server-side fallback.

Source: https://github.com/arthi-arumugam-git/billproof

Happy to be told where the pricing table is wrong; every row cites the page and fetch date.

## r/ClaudeAI

**Title:** I priced 48,000 of my Claude Code requests against the actual pricing page. Cache reads were 74.5% of the bill. Here's the tool.

**Body:**

Every "why did my usage window jump" thread here has the same shape: something happened in one turn and nobody can see what. The transcripts in `~/.claude/projects` carry the exact usage object Anthropic billed, so I wrote a tool that reads them and prices each turn properly.

Three things trip up the counters I've seen posted:

1. Claude Code writes one JSONL line per content block and repeats the usage on each. Sum lines and a thinking+text+tool turn counts three times. On my machine: +121%.
2. There are two cache write tiers. 5-minute is 1.25x, 1-hour is 2x. More than half my turns were 1-hour.
3. Cache reads are 0.1x. Not zero, not full price.

`npx billproof` gives you the true total by day, model, project, skill, MCP server and subagent, and shows the four wrong methods next to it. Free, local, no upload.

The paid receipt ($29 once) goes turn by turn: "9h idle, 600k tokens re-written at write price instead of read price, $6.03" and so on. It also catches the case where the cache is re-written three minutes after the last turn with zero reads, which is not an expiry but a changed prefix, usually compaction.

Repo: https://github.com/arthi-arumugam-git/billproof. If you are on Max and never see a dollar figure, the number still tracks how fast the window drains, and the tool says so instead of pretending.

## r/ClaudeCode

Same as r/ClaudeAI, title: "billproof: which turn ate your usage window, and why (reads your local transcripts, nothing uploaded)".

## X / Bluesky (thread)

1/ I priced 48,522 of my own Claude Code requests the way Anthropic's pricing page says. True total: $12,573. What a line-summing counter reports: $27,773. What a cache-blind one reports: $1,078. Same transcripts.

2/ Why: Claude Code writes one line per content block with the usage repeated; 5-minute and 1-hour cache writes are priced differently (1.25x vs 2x); cache reads are 0.1x and were 74.5% of my bill.

3/ `npx billproof` — free, local, nothing uploaded. Paid receipt ($29 once) labels each turn: cache-expired, prefix-changed, one-hour-write, subagent, fast-mode, fallback. github.com/arthi-arumugam-git/billproof

## Where NOT to post

No cold DMs, no template replies in other people's threads. Arthi's own measurement across ~110 sends: template openers produce zero replies. Replying with a real number to a real question is the only outreach that has ever worked for her, and that stays manual.
