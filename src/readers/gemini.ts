import type { Turn } from "../types.js";

/**
 * Gemini CLI sessions: ~/.gemini/tmp/<project-hash>/chats/session-<ts>-<id>.json
 *
 * Shape, verified on 10 real sessions on 2026-09-02: one JSON document per session,
 *   {sessionId, projectHash, startTime, lastUpdated, messages:[{id, timestamp, type:"user"|"gemini", model,
 *    tokens:{input, output, cached, thoughts, tool, total}, ...}]}
 * On every one of 382 model messages, total == input + output + thoughts + tool and cached <= input, so cached
 * is inside input (the OpenAI convention) and thoughts are billed as output (the pricing page says "Output
 * price (including thinking tokens)"). Normalised here to billproof's convention.
 */

interface GeminiSession {
  sessionId?: string;
  projectHash?: string;
  messages?: Array<{
    id?: string;
    timestamp?: string;
    type?: string;
    model?: string;
    tokens?: { input?: number; output?: number; cached?: number; thoughts?: number; tool?: number; total?: number };
  }>;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function parseGeminiSession(text: string, file: string): Turn[] {
  let doc: GeminiSession;
  try {
    doc = JSON.parse(text) as GeminiSession;
  } catch {
    return [];
  }
  const sessionId = doc.sessionId || file;
  const turns: Turn[] = [];
  let index = 0;
  for (const m of doc.messages ?? []) {
    if (!m.tokens || !m.model) continue;
    const ts = m.timestamp ? Date.parse(m.timestamp) : NaN;
    if (!Number.isFinite(ts)) continue;
    const gross = n(m.tokens.input);
    const cached = Math.min(n(m.tokens.cached), gross);
    const thoughts = n(m.tokens.thoughts);
    index += 1;
    turns.push({
      id: m.id ?? `${sessionId}:${index}`,
      provider: "gemini",
      source: "gemini-cli",
      sessionId,
      ts,
      model: m.model,
      usage: {
        input_tokens: gross - cached,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0,
        output_tokens: n(m.tokens.output) + thoughts + n(m.tokens.tool),
        reasoning_output_tokens: thoughts,
        gross_input_tokens: gross,
      },
      cwd: doc.projectHash ? `gemini:${doc.projectHash.slice(0, 12)}` : undefined,
      sidechain: false,
      file,
      content: [],
      lines: 1,
    });
  }
  return turns;
}
