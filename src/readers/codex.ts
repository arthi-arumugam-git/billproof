import type { Turn } from "../types.js";

/**
 * OpenAI Codex CLI sessions: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
 *
 * Shape, verified on 48 real sessions on 2026-09-02:
 *  - first line: {type:"session_meta", payload:{id, timestamp, cwd, cli_version, model_provider, ...}}
 *  - {type:"turn_context", payload:{model:"gpt-5.4", cwd, ...}} before each turn; the model can change mid-session
 *  - {type:"event_msg", payload:{type:"token_count", info:{total_token_usage:{...}, last_token_usage:{...}} | null}}
 *
 * Two facts decide how this is read:
 *  1. token_count fires several times per turn with the same last_token_usage (7,017 events for 5,177 turns on
 *     this machine; 39 carry info:null). Summing events over-counts. A turn is one *change* of last_token_usage.
 *  2. OpenAI's convention: cached_input_tokens is INSIDE input_tokens, and reasoning_output_tokens is INSIDE
 *     output_tokens (total_tokens == input + output held on 5,147 of 5,177 turns). This reader normalises to
 *     billproof's convention where input_tokens is the uncached remainder.
 */

interface CodexLine {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    id?: string;
    timestamp?: string;
    cwd?: string;
    cli_version?: string;
    model?: string;
    info?: {
      total_token_usage?: CodexUsage;
      last_token_usage?: CodexUsage;
      model_context_window?: number;
    } | null;
  };
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function parseCodexSession(text: string, file: string): Turn[] {
  const turns: Turn[] = [];
  let sessionId = "";
  let cwd: string | undefined;
  let version: string | undefined;
  let model = "";
  let prevKey = "";
  let pendingLines = 0;
  let index = 0;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let d: CodexLine;
    try {
      d = JSON.parse(line) as CodexLine;
    } catch {
      continue;
    }
    const p = d.payload ?? {};
    if (d.type === "session_meta") {
      sessionId = p.id ?? sessionId;
      cwd = p.cwd ?? cwd;
      version = p.cli_version ?? version;
      continue;
    }
    if (d.type === "turn_context") {
      if (p.model) model = p.model;
      continue;
    }
    if (d.type !== "event_msg" || p.type !== "token_count") continue;
    pendingLines += 1;
    const last = p.info?.last_token_usage;
    if (!last) continue;
    const key = JSON.stringify([last.input_tokens, last.cached_input_tokens, last.output_tokens, last.reasoning_output_tokens]);
    if (key === prevKey) continue;
    prevKey = key;
    const ts = d.timestamp ? Date.parse(d.timestamp) : NaN;
    if (!Number.isFinite(ts) || !model) {
      pendingLines = 0;
      continue;
    }
    const gross = n(last.input_tokens);
    const cached = Math.min(n(last.cached_input_tokens), gross);
    const output = n(last.output_tokens);
    index += 1;
    turns.push({
      id: `${sessionId || file}:${index}`,
      provider: "openai",
      source: "codex",
      sessionId: sessionId || file,
      ts,
      model,
      usage: {
        input_tokens: gross - cached,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0,
        output_tokens: output,
        reasoning_output_tokens: n(last.reasoning_output_tokens),
        gross_input_tokens: gross,
      },
      cwd,
      version,
      sidechain: false,
      file,
      content: [],
      lines: pendingLines,
    });
    pendingLines = 0;
  }
  return turns;
}
