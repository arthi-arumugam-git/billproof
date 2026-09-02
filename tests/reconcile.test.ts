import { describe, expect, it } from "vitest";
import {
  costToDaily,
  fetchCost,
  fetchUsage,
  modelFromDescription,
  parseLocalJson,
  priceDaily,
  reconcile,
  tokensOf,
  turnsToDaily,
  usageToDaily,
  type DailyUsage,
} from "../src/reconcile.js";
import { tierOf } from "../src/license.js";
import { renderReconcile } from "../src/report/terminal.js";
import type { Turn } from "../src/types.js";

const day = "2026-09-01";
const row = (over: Partial<DailyUsage> = {}): DailyUsage => ({ day, model: "claude-opus-5", uncached: 10_000, write5m: 50_000, write1h: 20_000, read: 900_000, output: 30_000, ...over });
const noCost = () => costToDaily([]);

const mk = (over: Partial<Turn> & { usage?: Partial<Turn["usage"]> } = {}): Turn => ({
  id: Math.random().toString(36),
  provider: "anthropic",
  source: "claude-code",
  sessionId: "s",
  ts: Date.parse(`${day}T10:00:00Z`),
  model: "claude-opus-5",
  sidechain: false,
  file: "f",
  content: [],
  lines: 1,
  ...over,
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...(over.usage ?? {}) },
});

describe("provider usage report -> daily rows", () => {
  it("keeps the 5m/1h write split and falls back to the legacy creation total", () => {
    const rows = usageToDaily([
      {
        starting_at: `${day}T00:00:00Z`,
        results: [
          { model: "claude-opus-5", uncached_input_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 }, cache_read_input_tokens: 4, output_tokens: 5 },
          { model: "claude-sonnet-5", uncached_input_tokens: 1, cache_creation_input_tokens: 9, cache_read_input_tokens: 0, output_tokens: 0 },
        ],
      },
    ]);
    expect(rows).toEqual([
      { day, model: "claude-opus-5", uncached: 1, write5m: 2, write1h: 3, read: 4, output: 5 },
      { day, model: "claude-sonnet-5", uncached: 1, write5m: 9, write1h: 0, read: 0, output: 0 },
    ]);
  });
});

describe("local turns -> daily rows", () => {
  it("aggregates by UTC day and model and ignores providers the Anthropic invoice does not cover", () => {
    const rows = turnsToDaily([
      mk({ usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 5 } } }),
      mk({ usage: { input_tokens: 20, output_tokens: 2, cache_read_input_tokens: 200, cache_creation_input_tokens: 7 } }),
      mk({ ts: Date.parse(`${day}T23:59:59Z`) + 1000, usage: { input_tokens: 1 } }),
      mk({ provider: "openai", source: "codex", model: "gpt-5", usage: { input_tokens: 999 } }),
    ]);
    expect(rows).toEqual([
      { day, model: "claude-opus-5", uncached: 30, write5m: 7, write1h: 5, read: 300, output: 3 },
      { day: "2026-09-02", model: "claude-opus-5", uncached: 1, write5m: 0, write1h: 0, read: 0, output: 0 },
    ]);
  });
});

describe("cost report", () => {
  it("attributes amounts to a model from the line description", () => {
    expect(modelFromDescription("Claude Opus 5 Usage - Input Tokens")).toBe("claude-opus-5");
    expect(modelFromDescription("Claude Fable 5.1 Usage - Output Tokens")).toBe("claude-fable-5-1");
    expect(modelFromDescription("Web Search Usage")).toBeNull();
    const c = costToDaily([
      { starting_at: `${day}T00:00:00Z`, results: [{ amount: "1.5", currency: "USD", description: "Claude Opus 5 Usage - Input Tokens" }, { amount: 2, description: "Claude Opus 5 Usage - Output Tokens" }, { amount: "0.25", description: "Web Search Usage" }] },
    ]);
    expect(c.byDay.get(day)).toBeCloseTo(3.75);
    expect(c.byDayModel.get(`${day}|claude-opus-5`)).toBeCloseTo(3.5);
    expect(c.currency).toBe("USD");
  });
});

describe("reconcile labels", () => {
  const api = [row()];
  const labelsOf = (local: DailyUsage[], apiRows = api, cost = noCost()) => reconcile(local, apiRows, cost, day, day).rows.map((r) => r.labels);

  it("match when both sides agree within 1%", () => {
    expect(labelsOf([row({ output: 30_100 })])).toEqual([["match"]]);
  });
  it("local-missing when only the provider has the row, local-extra the other way", () => {
    expect(labelsOf([])).toEqual([["local-missing"]]);
    expect(labelsOf([row()], [])).toEqual([["local-extra"]]);
  });
  it("token-drift when totals differ by more than 1%, with the direction in the note", () => {
    const r = reconcile([row({ read: 2_100_000 })], api, noCost(), day, day).rows[0];
    expect(r.labels).toEqual(["token-drift"]);
    expect(r.note).toMatch(/local counts more/);
    expect(reconcile([row({ read: 450_000 })], api, noCost(), day, day).rows[0].note).toMatch(/fewer/);
  });
  it("cache-split-drift when local input_tokens include the cache reads (inclusive convention)", () => {
    const r = reconcile([row({ uncached: 10_000 + 900_000 })], api, noCost(), day, day).rows[0];
    expect(r.labels).toEqual(["cache-split-drift"]);
    expect(r.note).toMatch(/counted twice/);
  });
  it("cache-split-drift when totals agree but the tier split does not", () => {
    const r = reconcile([row({ write5m: 70_000, write1h: 0 })], api, noCost(), day, day).rows[0];
    expect(r.labels).toEqual(["cache-split-drift"]);
    expect(r.note).toMatch(/5m vs 1h/);
  });
  it("price-drift only when the local metering states its own dollars and they are off", () => {
    const list = priceDaily(row());
    expect(labelsOf([row({ usd: list * 1.1 })])).toEqual([["price-drift"]]);
    expect(labelsOf([row({ usd: list })])).toEqual([["match"]]);
  });
  it("billed-vs-priced when the cost report disagrees with usage x list price", () => {
    const list = priceDaily(row());
    const cost = costToDaily([{ starting_at: `${day}T00:00:00Z`, results: [{ amount: list * 0.5, description: "Claude Opus 5 Usage - Input Tokens" }] }]);
    const r = reconcile([row()], api, cost, day, day);
    expect(r.rows[0].labels).toEqual(["match", "billed-vs-priced"]);
    expect(r.totals.billedUsd).toBeCloseTo(list * 0.5);
    expect(r.rows[0].billedUsd).toBeCloseTo(list * 0.5);
  });
  it("unknown-model prices both sides at zero and says so", () => {
    const r = reconcile([row({ model: "llama-4-maverick" })], [row({ model: "llama-4-maverick" })], noCost(), day, day).rows[0];
    expect(r.labels).toContain("unknown-model");
    expect(r.localUsd).toBe(0);
  });
  it("totals and byLabel add up", () => {
    const r = reconcile([row(), row({ day: "2026-09-02" })], [row(), row({ day: "2026-09-03" })], noCost(), day, "2026-09-03");
    expect(r.rows.map((x) => x.day)).toEqual([day, "2026-09-02", "2026-09-03"]);
    expect(r.byLabel).toEqual({ match: 1, "local-extra": 1, "local-missing": 1 });
    expect(r.totals.localTokens).toBe(2 * tokensOf(row()));
    expect(r.totals.apiTokens).toBe(2 * tokensOf(row()));
    const text = renderReconcile(r);
    expect(text).toContain("local-missing");
    expect(text).toContain("provider cost report");
  });
});

describe("local JSON rows", () => {
  it("accepts an array or {rows}, field aliases, and the metering's own dollars", () => {
    const a = parseLocalJson(JSON.stringify([{ date: `${day}T05:00:00Z`, model: "claude-opus-5", input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3, cost_usd: "0.5" }]));
    expect(a).toEqual([{ day, model: "claude-opus-5", uncached: 1, write5m: 0, write1h: 0, read: 2, output: 3, usd: 0.5 }]);
    const b = parseLocalJson(JSON.stringify({ rows: [{ day, model: "m", uncached: 1 }] }));
    expect(b[0]).toEqual({ day, model: "m", uncached: 1, write5m: 0, write1h: 0, read: 0, output: 0 });
    expect(b[0]).not.toHaveProperty("usd");
  });
  it("rejects rows without a day or model", () => {
    expect(() => parseLocalJson(JSON.stringify([{ model: "m" }]))).toThrow(/day/);
    expect(() => parseLocalJson("{}")).toThrow(/array/);
  });
});

describe("Admin API fetch", () => {
  const bucket = (n: number) => ({ starting_at: `2026-09-0${n}T00:00:00Z`, results: [] });
  const fake = (calls: Array<{ url: URL; headers: Record<string, string> }>, status = 200) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      const page = url.searchParams.get("page");
      const body = page ? { data: [bucket(2)], has_more: false } : { data: [bucket(1)], has_more: true, next_page: "p2" };
      return new Response(status === 200 ? JSON.stringify(body) : "nope", { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

  it("sends the admin key, asks for daily buckets by model, and follows pagination", async () => {
    const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
    const out = await fetchUsage("sk-ant-admin-x", "2026-09-01", "2026-09-03", fake(calls));
    expect(out.map((b) => b.starting_at.slice(0, 10))).toEqual(["2026-09-01", "2026-09-02"]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url.pathname).toBe("/v1/organizations/usage_report/messages");
    expect(calls[0].url.searchParams.get("starting_at")).toBe("2026-09-01T00:00:00Z");
    expect(calls[0].url.searchParams.get("ending_at")).toBe("2026-09-03T00:00:00Z");
    expect(calls[0].url.searchParams.get("bucket_width")).toBe("1d");
    expect(calls[0].url.searchParams.getAll("group_by[]")).toEqual(["model"]);
    expect(calls[0].headers["x-api-key"]).toBe("sk-ant-admin-x");
    expect(calls[1].url.searchParams.get("page")).toBe("p2");
    const costCalls: Array<{ url: URL; headers: Record<string, string> }> = [];
    await fetchCost("k", "2026-09-01", "2026-09-03", fake(costCalls));
    expect(costCalls[0].url.pathname).toBe("/v1/organizations/cost_report");
    expect(costCalls[0].url.searchParams.getAll("group_by[]")).toEqual(["description"]);
  });
  it("turns a non-2xx into an error that names the endpoint and status", async () => {
    await expect(fetchUsage("k", "2026-09-01", "2026-09-02", fake([], 401))).rejects.toThrow(/usage_report\/messages returned 401/);
  });
});

describe("licence tiers", () => {
  it("a Team key is the product prefix plus TEAM; solo keys and strangers are not", () => {
    expect(tierOf("BILLPROOF-TEAM-ABCD-1234")).toBe("team");
    expect(tierOf("billproof-team-abcd")).toBe("team");
    expect(tierOf("BILLPROOF-ABCD-1234")).toBe("solo");
    expect(tierOf("")).toBe("solo");
  });
});
