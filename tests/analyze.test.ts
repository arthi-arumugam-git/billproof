import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { dedupe } from "../src/dedupe.js";
import { findTranscripts, readTurns } from "../src/discover.js";
import { analyzeTurn, receipt, THRESHOLDS } from "../src/analyze/receipt.js";
import { scan } from "../src/analyze/scan.js";
import { priceTurn } from "../src/pricing/price.js";
import type { Turn } from "../src/types.js";

const FIX = join(import.meta.dirname, "fixtures");

async function load(): Promise<Turn[]> {
  const files = await findTranscripts(FIX);
  const raw: Turn[] = [];
  for await (const t of readTurns(files)) raw.push(t);
  return dedupe(raw);
}

const mk = (over: Partial<Turn> & { usage?: Partial<Turn["usage"]> } = {}): Turn => ({
  id: Math.random().toString(36),
  sessionId: "s",
  ts: Date.parse("2026-09-01T10:00:00Z"),
  model: "claude-opus-5",
  sidechain: false,
  file: "f",
  content: [],
  lines: 1,
  ...over,
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...(over.usage ?? {}) },
});

describe("fixtures load and dedupe", () => {
  it("collapses multi-line messages and prices every turn with a known model", async () => {
    const turns = await load();
    expect(turns.length).toBeGreaterThan(20);
    expect(turns.some((t) => t.lines > 1)).toBe(true);
    const s = scan(turns, "model");
    expect(s.unknownModels).toEqual([]);
    expect(s.total.total).toBeGreaterThan(0);
    expect(s.lines).toBeGreaterThan(s.turns);
    // line-summing must over-report on this corpus
    const lineSummed = s.naive.find((n) => n.method === "line-summed")!;
    expect(lineSummed.total).toBeGreaterThan(s.total.total);
  });

  it("the fallback fixture carries a fallback iteration priced at its own model", async () => {
    const turns = await load();
    const fb = turns.filter((t) => t.usage.iterations?.some((i) => i.type === "fallback_message"));
    expect(fb.length).toBeGreaterThan(0);
    const c = priceTurn(fb[0]);
    expect(c.flags).toContain("fallback");
    expect(c.iterations!.length).toBeGreaterThan(1);
  });

  it("the idle-gap fixture yields a cache-expired finding on a real session", async () => {
    const turns = await load();
    const sessions = [...new Set(turns.map((t) => t.sessionId))];
    const found = sessions.map((s) => receipt(turns, s)).flatMap((r) => r.items.flatMap((i) => i.findings)).filter((f) => f.cause === "cache-expired");
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].attributed).toBeGreaterThan(0);
  });

  it("the subagent fixture is attributed to the subagent lane", async () => {
    const turns = await load();
    const sub = turns.filter((t) => t.sidechain || t.agentId);
    expect(sub.length).toBeGreaterThan(0);
    const s = scan(turns, "agent");
    expect(s.groups.some((g) => g.key.startsWith("subagent"))).toBe(true);
  });
});

describe("receipt rules on synthetic turns", () => {
  it("cache-expired fires only after the TTL and only when most of the cache is rewritten", () => {
    const prev = mk({ ts: 0, usage: { cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } });
    const soon = mk({ ts: THRESHOLDS.ttl5mMs - 1000, usage: { cache_creation_input_tokens: 100_000 } });
    const late = mk({ ts: THRESHOLDS.ttl5mMs + 1000, usage: { cache_creation_input_tokens: 100_000, cache_creation: { ephemeral_5m_input_tokens: 100_000, ephemeral_1h_input_tokens: 0 } } });
    const lateSmall = mk({ ts: THRESHOLDS.ttl5mMs + 1000, usage: { cache_creation_input_tokens: 1_000, cache_read_input_tokens: 99_000 } });
    expect(analyzeTurn(soon, prev, priceTurn(soon)).map((f) => f.cause)).not.toContain("cache-expired");
    const f = analyzeTurn(late, prev, priceTurn(late)).find((x) => x.cause === "cache-expired")!;
    expect(f).toBeDefined();
    // 100k tokens rewritten at 5m ($6.25/M) instead of read ($0.50/M): $0.575
    expect(f.attributed).toBeCloseTo(0.575, 6);
    expect(analyzeTurn(lateSmall, prev, priceTurn(lateSmall)).map((f) => f.cause)).not.toContain("cache-expired");
  });

  it("a 1h previous write extends the TTL to 60 minutes", () => {
    const prev = mk({ ts: 0, usage: { cache_creation_input_tokens: 50_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 50_000 } } });
    const at30 = mk({ ts: 30 * 60_000, usage: { cache_creation_input_tokens: 50_000 } });
    const at61 = mk({ ts: 61 * 60_000, usage: { cache_creation_input_tokens: 50_000 } });
    expect(analyzeTurn(at30, prev, priceTurn(at30)).map((f) => f.cause)).not.toContain("cache-expired");
    expect(analyzeTurn(at61, prev, priceTurn(at61)).map((f) => f.cause)).toContain("cache-expired");
  });

  it("prefix-changed when the cache is rewritten inside the TTL with few reads", () => {
    const prev = mk({ ts: 0, usage: { cache_read_input_tokens: 500_000, cache_creation_input_tokens: 2_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2_000 } } });
    const next = mk({ ts: 3 * 60_000, usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 500_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500_000 } } });
    const causes = analyzeTurn(next, prev, priceTurn(next)).map((f) => f.cause);
    expect(causes).toContain("prefix-changed");
    expect(causes).not.toContain("cache-expired");
    // a normal incremental turn (small write, big read) is not a prefix change
    const normal = mk({ ts: 4 * 60_000, usage: { cache_read_input_tokens: 500_000, cache_creation_input_tokens: 3_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3_000 } } });
    expect(analyzeTurn(normal, next, priceTurn(normal)).map((f) => f.cause)).not.toContain("prefix-changed");
  });

  it("model-switch, not cache-expired, when the model changed", () => {
    const prev = mk({ ts: 0, model: "claude-opus-5", usage: { cache_read_input_tokens: 100_000 } });
    const next = mk({ ts: 10_000, model: "claude-sonnet-5", usage: { cache_creation_input_tokens: 100_000 } });
    const causes = analyzeTurn(next, prev, priceTurn(next)).map((f) => f.cause);
    expect(causes).toContain("model-switch");
    expect(causes).not.toContain("cache-expired");
  });

  it("one-hour-write attributes the 0.75x premium over a 5m write", () => {
    const t = mk({ usage: { cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 } } });
    const f = analyzeTurn(t, null, priceTurn(t)).find((x) => x.cause === "one-hour-write")!;
    expect(f.attributed).toBeCloseTo(10 - 6.25, 10);
  });

  it("context-heavy, output-heavy, uncached-paste, fast-mode, us-only-geo, subagent", () => {
    const t = mk({
      sidechain: true,
      usage: { input_tokens: 25_000, output_tokens: 9_000, cache_read_input_tokens: 90_000, speed: "fast", inference_geo: "us" },
    });
    const causes = analyzeTurn(t, null, priceTurn(t)).map((f) => f.cause);
    for (const c of ["context-heavy", "output-heavy", "uncached-paste", "fast-mode", "us-only-geo", "subagent"]) expect(causes).toContain(c);
  });

  it("receipt keeps separate cache lanes for main and each subagent", () => {
    const a1 = mk({ sessionId: "x", ts: 0, usage: { cache_creation_input_tokens: 10_000, cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 0 } } });
    const sub = mk({ sessionId: "x", ts: 1_000, agentId: "agent1", sidechain: true, usage: { cache_creation_input_tokens: 50_000 } });
    const a2 = mk({ sessionId: "x", ts: 2_000, usage: { cache_read_input_tokens: 10_000 } });
    const r = receipt([a1, sub, a2], "x");
    expect(r.turns).toBe(3);
    expect(r.items[2].gapMs).toBe(2_000); // main lane: previous main turn was at 0, not the subagent at 1_000
    expect(r.items[1].findings.map((f) => f.cause)).toContain("subagent");
  });
});
