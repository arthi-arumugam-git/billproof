import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCodexSession } from "../src/readers/codex.js";
import { parseGeminiSession } from "../src/readers/gemini.js";
import { priceTurn } from "../src/pricing/price.js";
import { lookupPrice } from "../src/pricing/table.js";
import { scan } from "../src/analyze/scan.js";
import { findSessionFiles, parseSource } from "../src/sources.js";

const FIX = join(import.meta.dirname, "fixtures");
const codexText = readFileSync(join(FIX, "codex", "rollout-fixture.jsonl"), "utf8");
const geminiText = readFileSync(join(FIX, "gemini", "hash", "chats", "session-fixture.json"), "utf8");

describe("Codex reader", () => {
  const turns = parseCodexSession(codexText, "rollout-fixture.jsonl");
  const events = codexText.split("\n").filter((l) => l.includes('"token_count"')).length;

  it("collapses repeated token_count events into one turn per usage change", () => {
    expect(turns.length).toBeGreaterThan(10);
    expect(turns.length).toBeLessThan(events); // the over-count a naive reader would commit
    const carried = turns.reduce((a, t) => a + t.lines, 0);
    expect(carried).toBeLessThanOrEqual(events);
  });

  it("normalises OpenAI's cached-inside-input convention to uncached input plus cache reads", () => {
    for (const t of turns) {
      const u = t.usage;
      expect(u.input_tokens).toBeGreaterThanOrEqual(0);
      expect(u.input_tokens + u.cache_read_input_tokens).toBe(u.gross_input_tokens);
      expect(u.cache_creation_input_tokens).toBe(0);
    }
    expect(turns.some((t) => t.usage.cache_read_input_tokens > 0)).toBe(true);
  });

  it("takes the model from turn_context and prices every turn with a known row", () => {
    for (const t of turns) {
      expect(t.model).toMatch(/^gpt-/);
      expect(t.provider).toBe("openai");
      expect(t.source).toBe("codex");
      expect(lookupPrice(t.model), t.model).toBeDefined();
    }
  });

  it("keeps the session id and never the content", () => {
    expect(new Set(turns.map((t) => t.sessionId)).size).toBe(1);
    expect(codexText).not.toContain('"text":'); // the fixture generator strips content lines
    expect(turns.every((t) => t.content.length === 0)).toBe(true);
  });

  it("prices cached input at the cached rate, not the input rate", () => {
    const t = turns.find((x) => x.usage.cache_read_input_tokens > 100_000) ?? turns.find((x) => x.usage.cache_read_input_tokens > 0)!;
    const row = lookupPrice(t.model)!;
    const c = priceTurn(t);
    const M = 1_000_000;
    expect(c.read).toBeCloseTo((t.usage.cache_read_input_tokens / M) * row.input * row.cacheReadMult, 8);
    expect(c.input).toBeCloseTo((t.usage.input_tokens / M) * row.input, 8);
    expect(c.write5m + c.write1h).toBe(0);
  });
});

describe("Gemini reader", () => {
  const turns = parseGeminiSession(geminiText, "session-fixture.json");
  const doc = JSON.parse(geminiText) as { messages: Array<{ tokens?: { input: number; output: number; cached: number; thoughts: number; tool: number; total: number } }> };
  const withTokens = doc.messages.filter((m) => m.tokens);

  it("yields one turn per model message that carries tokens", () => {
    expect(turns).toHaveLength(withTokens.length);
    expect(turns.every((t) => t.provider === "gemini" && t.source === "gemini-cli")).toBe(true);
  });

  it("bills thoughts as output and cached as a subset of input, matching the pricing page", () => {
    turns.forEach((t, i) => {
      const tk = withTokens[i].tokens!;
      expect(t.usage.output_tokens).toBe(tk.output + tk.thoughts + tk.tool);
      expect(t.usage.reasoning_output_tokens).toBe(tk.thoughts);
      expect(t.usage.input_tokens + t.usage.cache_read_input_tokens).toBe(tk.input);
      expect(t.usage.cache_read_input_tokens).toBe(Math.min(tk.cached, tk.input));
    });
  });

  it("prices every model in the fixture and flags the retired preview rather than guessing", () => {
    for (const t of turns) {
      const row = lookupPrice(t.model);
      expect(row, t.model).toBeDefined();
      const c = priceTurn(t);
      if (row!.verified === false) expect(c.flags).toContain("price-unverified");
    }
  });
});

describe("sources", () => {
  it("finds fixture session files by each source's layout", async () => {
    expect(await findSessionFiles("codex", join(FIX, "codex"))).toHaveLength(1);
    expect(await findSessionFiles("gemini-cli", join(FIX, "gemini"))).toHaveLength(1);
    // a Claude Code fixture is not a codex rollout and must not be picked up as one
    expect(await findSessionFiles("codex", FIX)).toHaveLength(1);
  });

  it("parses --source spellings and rejects unknown ones", () => {
    expect(parseSource(undefined)).toEqual(["claude-code", "codex", "gemini-cli"]);
    expect(parseSource("codex")).toEqual(["codex"]);
    expect(parseSource("claude,gemini")).toEqual(["claude-code", "gemini-cli"]);
    expect(() => parseSource("cursor")).toThrow(/--source/);
  });
});

describe("mixed-provider scan", () => {
  it("groups by provider and keeps the naive panel meaningful for OpenAI's convention", () => {
    const turns = [...parseCodexSession(codexText, "c"), ...parseGeminiSession(geminiText, "g")];
    const s = scan(turns, "provider");
    expect(s.groups.map((g) => g.key).sort()).toEqual(["gemini", "openai"]);
    expect(s.unknownModels).toEqual([]);
    // reading input_tokens without subtracting cached must over-report on a cache-heavy corpus
    const asInput = s.naive.find((n) => n.method === "cache-as-input")!;
    expect(asInput.total).toBeGreaterThan(s.total.total);
  });
});
