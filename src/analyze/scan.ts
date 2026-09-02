import { naive, priceTurn } from "../pricing/price.js";
import type { CostBreakdown, Turn, TurnCost } from "../types.js";

export type GroupBy = "day" | "model" | "project" | "skill" | "mcp" | "agent" | "session";

export interface GroupRow extends CostBreakdown {
  key: string;
  turns: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export interface NaiveDelta {
  method: string;
  what: string;
  total: number;
  /** (naive - true) / true */
  errorPct: number;
}

export interface ScanResult {
  from: number;
  to: number;
  turns: number;
  lines: number;
  sessions: number;
  total: CostBreakdown;
  groups: GroupRow[];
  topSessions: GroupRow[];
  naive: NaiveDelta[];
  flags: Record<string, number>;
  unknownModels: string[];
  tokens: { input: number; write5m: number; write1h: number; read: number; output: number };
}

function projectName(cwd?: string): string {
  if (!cwd) return "(unknown)";
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function groupKey(turn: Turn, by: GroupBy): string {
  switch (by) {
    case "day":
      return new Date(turn.ts).toISOString().slice(0, 10);
    case "model":
      return turn.model;
    case "project":
      return projectName(turn.cwd);
    case "skill":
      return turn.skill ?? "(no skill)";
    case "mcp":
      return turn.mcpServer ? `${turn.mcpServer}${turn.mcpTool ? "/" + turn.mcpTool : ""}` : "(no mcp)";
    case "agent":
      return turn.sidechain || turn.agentId ? `subagent${turn.agentId ? ":" + turn.agentId : ""}` : "main";
    case "session":
      return turn.sessionId;
  }
}

function emptyRow(key: string): GroupRow {
  return { key, turns: 0, input: 0, write5m: 0, write1h: 0, read: 0, output: 0, total: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
}

function addTo(row: GroupRow, t: Turn, c: TurnCost): void {
  row.turns += 1;
  row.input += c.input;
  row.write5m += c.write5m;
  row.write1h += c.write1h;
  row.read += c.read;
  row.output += c.output;
  row.total += c.total;
  row.inputTokens += t.usage.input_tokens;
  row.cacheWriteTokens += t.usage.cache_creation_input_tokens;
  row.cacheReadTokens += t.usage.cache_read_input_tokens;
  row.outputTokens += t.usage.output_tokens;
}

export function scan(turns: Turn[], by: GroupBy = "day"): ScanResult {
  const groups = new Map<string, GroupRow>();
  const sessions = new Map<string, GroupRow>();
  const total = emptyRow("total");
  const flags: Record<string, number> = {};
  const unknown = new Set<string>();
  let lines = 0;
  let n5m = 0;
  let cacheBlind = 0;
  let cacheAsInput = 0;
  let lineSummed = 0;
  let from = Infinity;
  let to = -Infinity;

  for (const t of turns) {
    const c = priceTurn(t);
    lines += t.lines;
    if (t.ts < from) from = t.ts;
    if (t.ts > to) to = t.ts;
    addTo(total, t, c);
    const k = groupKey(t, by);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = emptyRow(k)));
    addTo(g, t, c);
    let s = sessions.get(t.sessionId);
    if (!s) sessions.set(t.sessionId, (s = emptyRow(t.sessionId)));
    addTo(s, t, c);
    for (const f of c.flags) {
      flags[f] = (flags[f] ?? 0) + 1;
      if (f.startsWith("unknown-model:")) unknown.add(f.slice("unknown-model:".length));
    }
    n5m += naive.allWrites5m(t);
    cacheBlind += naive.cacheBlind(t);
    cacheAsInput += naive.cacheAsInput(t);
    lineSummed += c.total * t.lines;
  }

  const pct = (x: number) => (total.total > 0 ? (x - total.total) / total.total : 0);
  const naiveRows: NaiveDelta[] = [
    { method: "line-summed", what: "sums every transcript line; a message with thinking + text + tool_use counts three times", total: lineSummed, errorPct: pct(lineSummed) },
    { method: "all-writes-5m", what: "prices every cache write at 1.25x; ignores the 1-hour tier at 2x", total: n5m, errorPct: pct(n5m) },
    { method: "cache-as-input", what: "prices cache reads and writes as ordinary input; no cache discount", total: cacheAsInput, errorPct: pct(cacheAsInput) },
    { method: "cache-blind", what: "input + output only; cache tokens ignored", total: cacheBlind, errorPct: pct(cacheBlind) },
  ];

  const byTotal = (a: GroupRow, b: GroupRow) => b.total - a.total;
  const rows = [...groups.values()];
  rows.sort(by === "day" ? (a, b) => a.key.localeCompare(b.key) : byTotal);

  return {
    from: Number.isFinite(from) ? from : 0,
    to: Number.isFinite(to) ? to : 0,
    turns: turns.length,
    lines,
    sessions: sessions.size,
    total: { input: total.input, write5m: total.write5m, write1h: total.write1h, read: total.read, output: total.output, total: total.total },
    groups: rows,
    topSessions: [...sessions.values()].sort(byTotal).slice(0, 5),
    naive: naiveRows,
    flags,
    unknownModels: [...unknown],
    tokens: {
      input: total.inputTokens,
      write5m: turns.reduce((a, t) => a + (t.usage.cache_creation?.ephemeral_5m_input_tokens ?? 0), 0),
      write1h: turns.reduce((a, t) => a + (t.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0), 0),
      read: total.cacheReadTokens,
      output: total.outputTokens,
    },
  };
}
