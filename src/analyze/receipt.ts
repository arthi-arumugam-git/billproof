import { priceTurn } from "../pricing/price.js";
import { lookupPrice } from "../pricing/table.js";
import type { Turn, TurnCost } from "../types.js";

/**
 * Root-cause labels. Each rule reads only the fields named in `evidence`, so a reader can check it.
 * Attributed dollars answer "how much of this turn's cost is explained by this cause"; a turn can
 * carry several labels and attributions are not meant to sum to the turn total.
 */
export type Cause =
  | "cache-expired"
  | "one-hour-write"
  | "model-switch"
  | "prefix-changed"
  | "context-heavy"
  | "output-heavy"
  | "uncached-paste"
  | "subagent"
  | "fast-mode"
  | "us-only-geo"
  | "fallback"
  | "tier-unknown"
  | "price-unverified";

export interface Finding {
  cause: Cause;
  attributed: number;
  evidence: Record<string, string | number | boolean>;
}

export interface LineItem {
  turn: Turn;
  cost: TurnCost;
  index: number;
  /** ms since the previous turn in the same session, or null for the first */
  gapMs: number | null;
  findings: Finding[];
}

export interface Receipt {
  sessionId: string;
  project: string;
  from: number;
  to: number;
  turns: number;
  total: number;
  items: LineItem[];
  byCause: Array<{ cause: Cause; turns: number; attributed: number }>;
  topTurns: LineItem[];
}

export const THRESHOLDS = {
  contextHeavy: 100_000,
  outputHeavy: 8_000,
  uncachedPaste: 20_000,
  /** a turn re-writes at least this share of what the previous turn had cached for it to count as an expiry */
  expiryShare: 0.5,
  ttl5mMs: 5 * 60 * 1000,
  ttl1hMs: 60 * 60 * 1000,
};

const M = 1_000_000;

/** Which TTL the previous turn's cache was written with. Absent split counts as 5m, Anthropic's default. */
function ttlOf(turn: Turn): number {
  const cc = turn.usage.cache_creation;
  if (cc && (cc.ephemeral_1h_input_tokens ?? 0) > 0) return THRESHOLDS.ttl1hMs;
  return THRESHOLDS.ttl5mMs;
}

export function analyzeTurn(turn: Turn, prev: Turn | null, cost: TurnCost): Finding[] {
  const f: Finding[] = [];
  const u = turn.usage;
  const row = lookupPrice(turn.model);
  const base = row?.input ?? 0;
  const readRate = base * (row?.cacheReadMult ?? 0.1);
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const creation = u.cache_creation_input_tokens;
  const writeRate = w1 > 0 && w5 === 0 ? base * (row?.write1hMult ?? 2) : base * (row?.write5mMult ?? 1.25);
  const k = cost.fast * cost.geo;

  if (prev && creation > 0) {
    const gap = turn.ts - prev.ts;
    const ttl = ttlOf(prev);
    const prevCached = prev.usage.cache_read_input_tokens + prev.usage.cache_creation_input_tokens;
    const share = prevCached > 0 ? creation / prevCached : 0;
    const sameModel = prev.model === turn.model;
    if (gap > ttl && share >= THRESHOLDS.expiryShare && sameModel) {
      f.push({
        cause: "cache-expired",
        attributed: (creation / M) * (writeRate - readRate) * k,
        evidence: { gapMinutes: Math.round(gap / 60000), ttlMinutes: ttl / 60000, rewrittenTokens: creation, previousCachedTokens: prevCached },
      });
    }
    if (gap <= ttl && share >= THRESHOLDS.expiryShare && sameModel && u.cache_read_input_tokens < creation) {
      // rewritten inside the TTL on the same model: the cached prefix itself changed
      // (compaction, an edited system prompt, a changed tool list), not an expiry
      f.push({
        cause: "prefix-changed",
        attributed: (creation / M) * (writeRate - readRate) * k,
        evidence: { gapMinutes: Math.round(gap / 60000), ttlMinutes: ttl / 60000, rewrittenTokens: creation, readTokens: u.cache_read_input_tokens, previousCachedTokens: prevCached },
      });
    }
    if (!sameModel && share >= THRESHOLDS.expiryShare) {
      f.push({
        cause: "model-switch",
        attributed: (creation / M) * (writeRate - readRate) * k,
        evidence: { from: prev.model, to: turn.model, rewrittenTokens: creation },
      });
    }
  }
  if (w1 > 0 && base > 0) {
    f.push({
      cause: "one-hour-write",
      attributed: (w1 / M) * base * ((row?.write1hMult ?? 2) - (row?.write5mMult ?? 1.25)) * k,
      evidence: { oneHourWriteTokens: w1, fiveMinuteWriteTokens: w5 },
    });
  }
  const context = u.input_tokens + u.cache_read_input_tokens + creation;
  if (context >= THRESHOLDS.contextHeavy) {
    f.push({ cause: "context-heavy", attributed: cost.read, evidence: { contextTokens: context, cacheReadTokens: u.cache_read_input_tokens } });
  }
  if (u.output_tokens >= THRESHOLDS.outputHeavy) {
    f.push({ cause: "output-heavy", attributed: cost.output, evidence: { outputTokens: u.output_tokens, effort: turn.effort ?? "" } });
  }
  if (u.input_tokens >= THRESHOLDS.uncachedPaste) {
    f.push({ cause: "uncached-paste", attributed: cost.input, evidence: { uncachedInputTokens: u.input_tokens } });
  }
  if (turn.sidechain || turn.agentId) {
    f.push({ cause: "subagent", attributed: cost.total, evidence: { agentId: turn.agentId ?? "", sidechain: turn.sidechain } });
  }
  if (cost.fast > 1) {
    f.push({ cause: "fast-mode", attributed: cost.total * (1 - 1 / cost.fast), evidence: { speed: u.speed ?? "" } });
  }
  if (cost.geo > 1) {
    f.push({ cause: "us-only-geo", attributed: cost.total * (1 - 1 / cost.geo), evidence: { inference_geo: u.inference_geo ?? "" } });
  }
  for (const it of cost.iterations ?? []) {
    if (it.type === "fallback_message") {
      f.push({ cause: "fallback", attributed: it.cost.total, evidence: { declinedModel: it.model } });
    }
  }
  if (cost.flags.includes("tier-unknown")) {
    f.push({ cause: "tier-unknown", attributed: 0, evidence: { note: "cache_creation has no 5m/1h split; priced as 5m" } });
  }
  if (cost.flags.includes("price-unverified")) {
    f.push({ cause: "price-unverified", attributed: 0, evidence: { model: turn.model } });
  }
  return f;
}

function projectName(cwd?: string): string {
  if (!cwd) return "(unknown)";
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** Build a receipt for one session. `turns` must be deduplicated and may contain other sessions. */
export function receipt(turns: Turn[], sessionId: string): Receipt {
  const mine = turns.filter((t) => t.sessionId === sessionId).sort((a, b) => a.ts - b.ts);
  const items: LineItem[] = [];
  // the previous turn on the same lane: main conversation and each subagent keep separate caches
  const lastByLane = new Map<string, Turn>();
  let total = 0;
  mine.forEach((turn, index) => {
    const lane = turn.agentId ?? (turn.sidechain ? "sidechain" : "main");
    const prev = lastByLane.get(lane) ?? null;
    const cost = priceTurn(turn);
    total += cost.total;
    items.push({ turn, cost, index, gapMs: prev ? turn.ts - prev.ts : null, findings: analyzeTurn(turn, prev, cost) });
    lastByLane.set(lane, turn);
  });
  const agg = new Map<Cause, { cause: Cause; turns: number; attributed: number }>();
  for (const it of items) {
    for (const f of it.findings) {
      const a = agg.get(f.cause) ?? { cause: f.cause, turns: 0, attributed: 0 };
      a.turns += 1;
      a.attributed += f.attributed;
      agg.set(f.cause, a);
    }
  }
  return {
    sessionId,
    project: projectName(mine[0]?.cwd),
    from: mine[0]?.ts ?? 0,
    to: mine[mine.length - 1]?.ts ?? 0,
    turns: mine.length,
    total,
    items,
    byCause: [...agg.values()].sort((a, b) => b.attributed - a.attributed),
    topTurns: [...items].sort((a, b) => b.cost.total - a.cost.total).slice(0, 10),
  };
}
