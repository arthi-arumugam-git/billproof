import type { Receipt } from "../analyze/receipt.js";
import type { ScanResult } from "../analyze/scan.js";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
};

export const num = (n: number): string => n.toLocaleString("en-US");
export const usd = (n: number): string => {
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
export const tok = (n: number): string => {
  if (n >= 1_000_000_000) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString("en-US");
};
const pct = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
/** share of a whole, for people whose unit is "how much of my window", not dollars */
const share = (part: number, whole: number): string => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "-");
const date = (ms: number): string => (ms ? new Date(ms).toISOString().slice(0, 10) : "-");
const time = (ms: number): string => (ms ? new Date(ms).toISOString().slice(11, 16) : "-");

function table(headers: string[], rows: string[][], align: Array<"l" | "r"> = []): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (cells: string[]) =>
    cells.map((cell, i) => ((align[i] ?? "l") === "r" ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join("  ");
  return [c.dim(fmt(headers)), c.dim(widths.map((w) => "-".repeat(w)).join("  ")), ...rows.map(fmt)].join("\n");
}

export function renderScan(s: ScanResult, by: string, dir: string): string {
  const out: string[] = [];
  out.push(c.bold(`billproof`) + c.dim(`  ${dir}`));
  out.push(c.dim(`${num(s.turns)} billed requests across ${num(s.sessions)} sessions, ${date(s.from)} to ${date(s.to)}; ${num(s.lines)} transcript lines read`));
  out.push("");
  out.push(c.bold(`True cost at list price: ${usd(s.total.total)}`));
  out.push(
    table(
      ["category", "tokens", "cost", "share"],
      [
        ["uncached input", tok(s.tokens.input), usd(s.total.input), pct(s.total.input / s.total.total - 0).replace("+", "")],
        ["cache write 5m (1.25x)", tok(s.tokens.write5m), usd(s.total.write5m), pct(s.total.write5m / s.total.total).replace("+", "")],
        ["cache write 1h (2x)", tok(s.tokens.write1h), usd(s.total.write1h), pct(s.total.write1h / s.total.total).replace("+", "")],
        ["cache read (0.1x)", tok(s.tokens.read), usd(s.total.read), pct(s.total.read / s.total.total).replace("+", "")],
        ["output", tok(s.tokens.output), usd(s.total.output), pct(s.total.output / s.total.total).replace("+", "")],
      ],
      ["l", "r", "r", "r"],
    ),
  );
  out.push("");
  out.push(c.bold(`What a naive counter would have told you`));
  out.push(
    table(
      ["method", "reports", "error", "why"],
      s.naive.map((n) => [n.method, usd(n.total), (n.errorPct > 0 ? c.red : c.yellow)(pct(n.errorPct)), n.what]),
      ["l", "r", "r", "l"],
    ),
  );
  out.push("");
  out.push(c.bold(`By ${by}`));
  out.push(
    table(
      [by, "requests", "cost", "share", "1h writes", "reads"],
      s.groups.slice(0, 40).map((g) => [g.key.length > 48 ? g.key.slice(0, 45) + "..." : g.key, num(g.turns), usd(g.total), share(g.total, s.total.total), usd(g.write1h), usd(g.read)]),
      ["l", "r", "r", "r", "r", "r"],
    ),
  );
  if (s.groups.length > 40) out.push(c.dim(`... ${s.groups.length - 40} more`));
  out.push("");
  out.push(c.bold(`Most expensive sessions`));
  out.push(table(["session", "requests", "cost", "share"], s.topSessions.map((g) => [g.key, num(g.turns), usd(g.total), share(g.total, s.total.total)]), ["l", "r", "r", "r"]));
  if (s.startupContext.sessions) {
    out.push("");
    out.push(c.bold(`Session start context`) + c.dim(`  what a cold session writes before you type: system prompt, tools, skills, memory`));
    out.push(`average ${tok(s.startupContext.avgTokens)} tokens across ${num(s.startupContext.sessions)} cold starts; largest ${tok(s.startupContext.maxTokens)} (${s.startupContext.maxSession.slice(0, 8)}). Trim with /context all.`);
  }
  const flagKeys = Object.keys(s.flags);
  if (flagKeys.length) {
    out.push("");
    out.push(c.dim(`flags: ${flagKeys.map((k) => `${k} x${s.flags[k]}`).join(", ")}`));
  }
  if (s.unknownModels.length) out.push(c.yellow(`unknown models priced at $0: ${s.unknownModels.join(", ")}`));
  out.push("");
  out.push(c.dim(`Prices: platform.claude.com/docs/en/about-claude/pricing (2026-09-02). Subscription plans do not bill per token; these are API list-price equivalents.`));
  out.push(c.dim(`Run \`billproof receipt <session>\` to see which turns cost the money and why.`));
  return out.join("\n");
}

export function renderReceipt(r: Receipt, opts: { all?: boolean } = {}): string {
  const out: string[] = [];
  out.push(c.bold(`billproof receipt`) + c.dim(`  session ${r.sessionId}`));
  out.push(c.dim(`${r.project}  ${date(r.from)} ${time(r.from)} to ${date(r.to)} ${time(r.to)}  ${r.turns} billed requests`));
  out.push("");
  out.push(c.bold(`Total ${usd(r.total)}`));
  out.push("");
  out.push(c.bold(`Where the money went`));
  out.push(
    table(
      ["cause", "turns", "attributed", "share", "meaning"],
      r.byCause.map((b) => [b.cause, String(b.turns), usd(b.attributed), share(b.attributed, r.total), CAUSE_TEXT[b.cause] ?? ""]),
      ["l", "r", "r", "r", "l"],
    ),
  );
  out.push("");
  const items = opts.all ? r.items : r.topTurns.sort((a, b) => a.index - b.index);
  out.push(c.bold(opts.all ? `Every turn` : `Ten most expensive turns`));
  out.push(
    table(
      ["#", "time", "gap", "model", "in", "w5m", "w1h", "read", "out", "cost", "share", "causes"],
      items.map((it) => [
        String(it.index + 1),
        time(it.turn.ts),
        it.gapMs === null ? "-" : it.gapMs > 3_600_000 ? `${Math.round(it.gapMs / 3_600_000)}h` : `${Math.round(it.gapMs / 60_000)}m`,
        it.turn.model.replace("claude-", ""),
        tok(it.turn.usage.input_tokens),
        tok(it.turn.usage.cache_creation?.ephemeral_5m_input_tokens ?? 0),
        tok(it.turn.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0),
        tok(it.turn.usage.cache_read_input_tokens),
        tok(it.turn.usage.output_tokens),
        usd(it.cost.total),
        share(it.cost.total, r.total),
        it.findings.filter((f) => f.attributed > 0).map((f) => f.cause).join(","),
      ]),
      ["r", "l", "r", "l", "r", "r", "r", "r", "r", "r", "r", "l"],
    ),
  );
  out.push("");
  out.push(c.dim(`Attributions explain a turn's cost from several angles and are not meant to sum to the total.`));
  return out.join("\n");
}

export const CAUSE_TEXT: Record<string, string> = {
  "cache-expired": "idle past the cache TTL; the whole context was re-written at write price instead of read price",
  "one-hour-write": "1-hour cache writes cost 2x base, the 5-minute tier costs 1.25x",
  "model-switch": "caches are per model; switching re-writes the context",
  "prefix-changed": "context re-written inside the TTL with few reads: compaction, an edited system prompt or a changed tool list broke the cached prefix",
  "context-heavy": "large context read on every turn",
  "output-heavy": "long output or thinking",
  "uncached-paste": "large uncached input, often a paste or image",
  subagent: "work done by subagents",
  "fast-mode": "fast mode premium (2x)",
  "us-only-geo": "US-only inference premium (1.1x)",
  fallback: "server-side fallback billed the declining model's partial output",
  "tier-unknown": "older transcript without the 5m/1h split; priced as 5m",
  "price-unverified": "legacy model price not on the current pricing page",
};
