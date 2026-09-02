import { describe, expect, it } from "vitest";
import { dedupe } from "../src/dedupe.js";
import { parseLine } from "../src/parse.js";
import { naive, priceTurn, priceUsage } from "../src/pricing/price.js";
import { lookupPrice } from "../src/pricing/table.js";
import type { Turn } from "../src/types.js";

const turn = (over: Partial<Turn> & { usage?: Partial<Turn["usage"]> } = {}): Turn => ({
  id: "msg_1",
  sessionId: "s1",
  ts: Date.parse("2026-09-01T10:00:00Z"),
  model: "claude-opus-5",
  sidechain: false,
  file: "f",
  content: ["text"],
  lines: 1,
  ...over,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...(over.usage ?? {}),
  },
});

describe("price table", () => {
  it("matches every current model id and dated variants", () => {
    expect(lookupPrice("claude-opus-5")?.model).toBe("claude-opus-5");
    expect(lookupPrice("claude-opus-4-8")?.model).toBe("claude-opus-4-8");
    expect(lookupPrice("claude-sonnet-5")?.model).toBe("claude-sonnet-5");
    expect(lookupPrice("claude-haiku-4-5-20251001")?.model).toBe("claude-haiku-4-5");
    expect(lookupPrice("claude-fable-5-1")?.model).toBe("claude-fable-5-1");
    expect(lookupPrice("claude-fable-5")?.model).toBe("claude-fable-5");
    expect(lookupPrice("anthropic.claude-opus-4-6-v1:0")?.model).toBe("claude-opus-4-6");
    expect(lookupPrice("claude-opus-4-1-20250805")?.model).toBe("claude-opus-4-1");
    expect(lookupPrice("claude-opus-4-20250514")?.model).toBe("claude-opus-4");
    expect(lookupPrice("claude-sonnet-4-20250514")?.model).toBe("claude-sonnet-4");
    expect(lookupPrice("gpt-5")).toBeUndefined();
  });

  it("Fable 5.1 cache reads are 0.025x, everyone else 0.1x (pricing page footnote 1)", () => {
    expect(lookupPrice("claude-fable-5-1")?.cacheReadMult).toBe(0.025);
    expect(lookupPrice("claude-fable-5")?.cacheReadMult).toBe(0.1);
    expect(lookupPrice("claude-opus-5")?.cacheReadMult).toBe(0.1);
  });
});

describe("priceUsage against the published per-MTok rates", () => {
  const opus = lookupPrice("claude-opus-5")!;

  it("1M base input on Opus 5 is $5, output $25", () => {
    expect(priceUsage({ input_tokens: 1_000_000 }, opus).total).toBeCloseTo(5, 10);
    expect(priceUsage({ output_tokens: 1_000_000 }, opus).total).toBeCloseTo(25, 10);
  });

  it("5m write is $6.25/MTok and 1h write is $10/MTok on Opus 5 (page columns)", () => {
    const c5 = priceUsage({ cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 0 } }, opus);
    const c1 = priceUsage({ cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 } }, opus);
    expect(c5.write5m).toBeCloseTo(6.25, 10);
    expect(c1.write1h).toBeCloseTo(10, 10);
    expect(c5.tierKnown).toBe(true);
  });

  it("cache read on Opus 5 is $0.50/MTok, on Fable 5.1 $0.25/MTok", () => {
    expect(priceUsage({ cache_read_input_tokens: 1_000_000 }, opus).read).toBeCloseTo(0.5, 10);
    expect(priceUsage({ cache_read_input_tokens: 1_000_000 }, lookupPrice("claude-fable-5-1")!).read).toBeCloseTo(0.25, 10);
  });

  it("without a 5m/1h split, writes price as 5m and the turn is flagged", () => {
    const c = priceUsage({ cache_creation_input_tokens: 1_000_000 }, opus);
    expect(c.write5m).toBeCloseTo(6.25, 10);
    expect(c.write1h).toBe(0);
    expect(c.tierKnown).toBe(false);
  });

  it("a split that does not sum to the total prices the remainder as 5m and flags", () => {
    const c = priceUsage({ cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 400_000, ephemeral_1h_input_tokens: 400_000 } }, opus);
    expect(c.write5m).toBeCloseTo(0.6 * 6.25, 10);
    expect(c.write1h).toBeCloseTo(0.4 * 10, 10);
    expect(c.tierKnown).toBe(false);
  });
});

describe("priceTurn multipliers and fallbacks", () => {
  it("fast mode doubles every category on Opus 5 (page: $10/$50 vs $5/$25)", () => {
    const t = turn({ usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, speed: "fast" } });
    const c = priceTurn(t);
    expect(c.total).toBeCloseTo(2 * (5 + 25), 10);
    expect(c.flags).toContain("fast-mode");
  });

  it("us-only inference multiplies by 1.1", () => {
    const t = turn({ usage: { input_tokens: 1_000_000, inference_geo: "us" } });
    expect(priceTurn(t).total).toBeCloseTo(5.5, 10);
  });

  it("not_available geo is standard pricing", () => {
    const t = turn({ usage: { input_tokens: 1_000_000, inference_geo: "not_available" } });
    expect(priceTurn(t).total).toBeCloseTo(5, 10);
  });

  it("a fallback iteration is priced at its own model, and the turn is flagged", () => {
    const t = turn({
      model: "claude-fable-5",
      usage: {
        input_tokens: 2_000_000,
        output_tokens: 0,
        iterations: [
          { type: "fallback_message", model: "claude-fable-5", input_tokens: 1_000_000 },
          { type: "message", model: "claude-opus-4-8", input_tokens: 1_000_000 },
        ],
      },
    });
    const c = priceTurn(t);
    expect(c.total).toBeCloseTo(10 + 5, 10);
    expect(c.flags).toContain("fallback");
    expect(c.iterations?.map((i) => i.model)).toEqual(["claude-fable-5", "claude-opus-4-8"]);
  });

  it("a single iteration without a model is priced at message.model, not double counted", () => {
    const t = turn({ usage: { input_tokens: 1_000_000, iterations: [{ type: "message", input_tokens: 1_000_000 }] } });
    expect(priceTurn(t).total).toBeCloseTo(5, 10);
  });

  it("unknown models price at zero and are flagged, never guessed", () => {
    const t = turn({ model: "claude-next-99", usage: { input_tokens: 1_000_000 } });
    const c = priceTurn(t);
    expect(c.total).toBe(0);
    expect(c.flags).toContain("unknown-model:claude-next-99");
  });

  it("legacy rows are flagged price-unverified", () => {
    const t = turn({ model: "claude-3-5-sonnet-20241022", usage: { input_tokens: 1_000_000 } });
    expect(priceTurn(t).flags).toContain("price-unverified");
  });
});

describe("naive methods reproduce the known defect classes", () => {
  it("all-writes-5m under-prices a 1h write by 37.5%", () => {
    const t = turn({ usage: { cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 } } });
    expect(priceTurn(t).total).toBeCloseTo(10, 10);
    expect(naive.allWrites5m(t)).toBeCloseTo(6.25, 10);
  });
  it("cache-blind drops cache tokens entirely", () => {
    const t = turn({ usage: { input_tokens: 10, cache_read_input_tokens: 1_000_000 } });
    expect(naive.cacheBlind(t)).toBeCloseTo(0.00005, 10);
    expect(priceTurn(t).total).toBeGreaterThan(0.5);
  });
});

describe("parse + dedupe reproduce the transcript over-count defect", () => {
  const line = (id: string, blockType: string, out = 100) => ({
    type: "assistant",
    uuid: `u-${id}-${blockType}`,
    requestId: `req_${id}`,
    sessionId: "s1",
    timestamp: "2026-09-01T10:00:00.000Z",
    cwd: "/p",
    message: {
      id: `msg_${id}`,
      model: "claude-opus-5",
      usage: { input_tokens: 5, output_tokens: out, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 } },
      content: [{ type: blockType }],
    },
  });

  it("three lines of one message collapse to one turn with the union of block types", () => {
    const parsed = [line("a", "thinking"), line("a", "text"), line("a", "tool_use"), line("b", "text")].map((l) => parseLine(l as never, "f")!);
    const turns = dedupe(parsed);
    expect(turns).toHaveLength(2);
    expect(turns[0].lines).toBe(3);
    expect(turns[0].content.sort()).toEqual(["text", "thinking", "tool_use"]);
    const summedLines = parsed.reduce((a, t) => a + priceTurn(t).total, 0);
    const trueTotal = turns.reduce((a, t) => a + priceTurn(t).total, 0);
    expect(summedLines).toBeCloseTo(trueTotal * 2, 10); // 4 lines vs 2 messages
  });

  it("the line with the larger output count wins", () => {
    const turns = dedupe([line("a", "thinking", 10), line("a", "text", 250)].map((l) => parseLine(l as never, "f")!));
    expect(turns[0].usage.output_tokens).toBe(250);
  });

  it("synthetic error lines and non-assistant lines are skipped", () => {
    expect(parseLine({ type: "user", message: { usage: { input_tokens: 1 } } } as never, "f")).toBeNull();
    expect(parseLine({ ...line("z", "text"), message: { ...line("z", "text").message, model: "<synthetic>" } } as never, "f")).toBeNull();
    expect(parseLine({ ...line("z", "text"), isApiErrorMessage: true } as never, "f")).toBeNull();
  });
});
