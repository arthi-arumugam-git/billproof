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

`npx billproof` is free and local; nothing leaves the machine. The paid part ($49 once) is a per-turn receipt that labels why a turn cost what it did: idle past the cache TTL, a prompt prefix that changed inside the TTL (compaction, edited system prompt), 1-hour tier premium, subagents on their own cache lane, fast mode, US-only routing, server-side fallback.

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

The paid receipt ($49 once) goes turn by turn: "9h idle, 600k tokens re-written at write price instead of read price, $6.03" and so on. It also catches the case where the cache is re-written three minutes after the last turn with zero reads, which is not an expiry but a changed prefix, usually compaction.

Repo: https://github.com/arthi-arumugam-git/billproof. If you are on Max and never see a dollar figure, the number still tracks how fast the window drains, and the tool says so instead of pretending.

## r/ClaudeCode

Same as r/ClaudeAI, title: "billproof: which turn ate your usage window, and why (reads your local transcripts, nothing uploaded)".

## X / Bluesky (thread)

1/ I priced 48,522 of my own Claude Code requests the way Anthropic's pricing page says. True total: $12,573. What a line-summing counter reports: $27,773. What a cache-blind one reports: $1,078. Same transcripts.

2/ Why: Claude Code writes one line per content block with the usage repeated; 5-minute and 1-hour cache writes are priced differently (1.25x vs 2x); cache reads are 0.1x and were 74.5% of my bill.

3/ `npx billproof` — free, local, nothing uploaded. Paid receipt ($49 once) labels each turn: cache-expired, prefix-changed, one-hour-write, subagent, fast-mode, fallback. github.com/arthi-arumugam-git/billproof

## Where NOT to post

No cold DMs, no template replies in other people's threads. Arthi's own measurement across ~110 sends: template openers produce zero replies. Replying with a real number to a real question is the only outreach that has ever worked for her, and that stays manual.

## Reddit replies, where the demand already is (found 2026-09-02 via Apify; scores as of that day)

Rule: reply only with a real number from your own machine, once per thread, no link in the first sentence. If the thread is older than two weeks, skip it; comment on the next one like it instead.

### r/ClaudeAI, 92 pts / 78 comments, "Claude Code hitting the 5-hour usage limit much faster than usual, is something changing?"
https://www.reddit.com/r/ClaudeAI/comments/1vp5cqt/claude_code_hitting_the_5hour_usage_limit_much/
OP removed plugins and skills to find the drain and still could not tell. Top comment (38 pts): "One day it takes hours to fill up the 5 hour limit and on other days it takes minutes."

> The transcripts in ~/.claude/projects record the exact usage object for every request, so you can see which turn did it rather than guessing. I priced 48k of my own requests: 74.5% of the cost-equivalent was cache reads, and the turns that spike are almost always one of three things: an idle gap longer than the cache TTL (the whole context gets re-written at 2x instead of read at 0.1x), a prompt prefix that changed inside the TTL (compaction, an edited CLAUDE.md, a changed tool list), or a subagent on its own cache lane. On my machine the biggest single turn was 783k tokens re-written after a 1h idle.
>
> I wrote a small local tool for this: `npx billproof` gives cost by skill / MCP server / subagent (free, nothing uploaded); the paid receipt labels each turn with the cause. Happy to read a session of yours if you paste the `--json` output.

### r/ClaudeAI, 158 pts / 42 comments, "How I got my Mac to read my Claude Code chats at night and extend my token usage by 1/3rd"
https://www.reddit.com/r/ClaudeAI/comments/1w06a7b/how_i_got_my_mac_to_read_my_claude_code_chats_at/
OP did the analysis by hand ("About a third of my usage was re-reads"). Top comment (21 pts): "Compact writes the summary with the paid model, mid-chat, after the bloat already billed you on every message before it."

> The re-read share is measurable straight from the JSONL: it is cache_read_input_tokens on each turn, priced at 0.1x base, and compaction shows up as a turn where cache_creation jumps and cache_read drops to ~0 within the TTL. Across 41 sessions here, reads were 74.5% of cost-equivalent and 1-hour cache writes another 11.6%. I automated exactly the count you did by hand (`npx billproof`, local only); the receipt version labels the compaction turns as prefix-changed so you can see what each one cost.

### r/ClaudeCode, 79 pts / 49 comments, "My fresh Claude Code sessions were starting at ~35K tokens. I got them down to ~13K."
https://www.reddit.com/r/ClaudeCode/comments/1vklbtg/my_fresh_claude_code_sessions_were_starting_at/

> Same measurement from the other side: the first request of a cold session has input + cache_creation equal to whatever /context all shows, and it is written to the cache at 1.25x or 2x base. billproof prints the average across your sessions ("Session start context") so you can see whether a cleanup like yours actually stuck.

### Skip
r/ClaudeAI 341 pts "Max 20x usage went from 0% to 100% in half an hour while I was not using Claude": that thread is about phantom usage and account security, not accounting. The only honest contribution would be "billproof can show that no request left this machine in that window", and that is a stretch. Leave it.
