import type { Turn } from "./types.js";

/**
 * Claude Code writes one transcript line per content block of an API response, and every line
 * repeats the full usage object. Summing lines therefore over-counts a message by the number of
 * blocks it had (thinking + text + tool_use = 3x). This collapses lines to one Turn per message.
 *
 * Key: message.id (stable across the lines of one response). When two lines with the same id
 * disagree on usage, the larger output_tokens wins: a later line can carry the completed count.
 */
export function dedupe(turns: Iterable<Turn>): Turn[] {
  const byId = new Map<string, Turn>();
  for (const t of turns) {
    const prev = byId.get(t.id);
    if (!prev) {
      byId.set(t.id, { ...t, content: [...t.content] });
      continue;
    }
    prev.lines += 1;
    for (const c of t.content) if (!prev.content.includes(c)) prev.content.push(c);
    if (t.usage.output_tokens > prev.usage.output_tokens) prev.usage = t.usage;
    if (t.ts < prev.ts) prev.ts = t.ts;
    // attribution fields can be absent on the first line and present on a later one
    prev.skill ??= t.skill;
    prev.mcpServer ??= t.mcpServer;
    prev.mcpTool ??= t.mcpTool;
    prev.plugin ??= t.plugin;
    prev.agentId ??= t.agentId;
  }
  return [...byId.values()].sort((a, b) => a.ts - b.ts);
}

/** Total lines that were folded away; useful for the "what a line-summing tool would report" panel. */
export function overcountFactor(turns: Turn[]): { turns: number; lines: number } {
  let lines = 0;
  for (const t of turns) lines += t.lines;
  return { turns: turns.length, lines };
}
