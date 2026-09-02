import type { CostBreakdown, Iteration, Turn, TurnCost, Usage } from "../types.js";
import { lookupPrice, US_GEO_MULT, type PriceRow } from "./table.js";

const M = 1_000_000;

export interface PriceOptions {
  /** what to assume when cache_creation has no 5m/1h split: "5m" (Anthropic's default TTL) */
  unknownTierAs?: "5m" | "1h";
}

/** Price one usage object at one model's list rates. No multipliers; flags collected by the caller. */
export function priceUsage(u: Partial<Usage> | Iteration, row: PriceRow, opts: PriceOptions = {}): CostBreakdown & { tierKnown: boolean } {
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const creation = u.cache_creation_input_tokens ?? 0;
  const cc = u.cache_creation;
  let w5 = 0;
  let w1 = 0;
  let tierKnown = false;
  if (cc && (cc.ephemeral_5m_input_tokens !== undefined || cc.ephemeral_1h_input_tokens !== undefined)) {
    w5 = cc.ephemeral_5m_input_tokens ?? 0;
    w1 = cc.ephemeral_1h_input_tokens ?? 0;
    tierKnown = true;
    // the split should sum to the total; if it does not, the remainder is priced at the default tier
    const rest = creation - w5 - w1;
    if (rest > 0) {
      if ((opts.unknownTierAs ?? "5m") === "1h") w1 += rest;
      else w5 += rest;
      tierKnown = false;
    }
  } else if ((opts.unknownTierAs ?? "5m") === "1h") {
    w1 = creation;
  } else {
    w5 = creation;
  }

  let inMult = 1;
  let outMult = 1;
  if (row.longContext) {
    const context = input + read + creation;
    if (context > row.longContext.threshold) {
      inMult = row.longContext.inputMult;
      outMult = row.longContext.outputMult;
    }
  }

  const c: CostBreakdown = {
    input: (input / M) * row.input * inMult,
    write5m: (w5 / M) * row.input * row.write5mMult * inMult,
    write1h: (w1 / M) * row.input * row.write1hMult * inMult,
    read: (read / M) * row.input * row.cacheReadMult * inMult,
    output: (output / M) * row.output * outMult,
    total: 0,
  };
  c.total = c.input + c.write5m + c.write1h + c.read + c.output;
  return { ...c, tierKnown };
}

function scale(c: CostBreakdown, k: number): CostBreakdown {
  return {
    input: c.input * k,
    write5m: c.write5m * k,
    write1h: c.write1h * k,
    read: c.read * k,
    output: c.output * k,
    total: c.total * k,
  };
}

function add(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  return {
    input: a.input + b.input,
    write5m: a.write5m + b.write5m,
    write1h: a.write1h + b.write1h,
    read: a.read + b.read,
    output: a.output + b.output,
    total: a.total + b.total,
  };
}

const ZERO: CostBreakdown = { input: 0, write5m: 0, write1h: 0, read: 0, output: 0, total: 0 };

/**
 * Price a deduplicated Turn the way Anthropic bills it.
 *
 * - With server-side fallbacks, usage.iterations holds one entry per model that ran; each is
 *   priced at its own model. Otherwise the top-level usage is priced at message.model.
 * - Fast mode and US-only inference multiply every category.
 * - Unknown models price at zero and are flagged, never guessed.
 */
export function priceTurn(turn: Turn, opts: PriceOptions = {}): TurnCost {
  const flags: string[] = [];
  const atIso = new Date(turn.ts).toISOString().slice(0, 10);
  const u = turn.usage;
  const fast = u.speed === "fast" ? 2 : 1;
  const geo = u.inference_geo === "us" ? US_GEO_MULT : 1;
  if (fast !== 1) flags.push("fast-mode");
  if (geo !== 1) flags.push("us-only-geo");

  const iters = u.iterations ?? [];
  const multiModel = iters.length > 1 || iters.some((i) => i.model && i.model !== turn.model);

  let cost: CostBreakdown = ZERO;
  let perIter: TurnCost["iterations"];
  if (multiModel) {
    perIter = [];
    for (const it of iters) {
      const model = it.model ?? turn.model;
      const row = lookupPrice(model, atIso);
      if (!row) {
        flags.push(`unknown-model:${model}`);
        perIter.push({ model, type: it.type, cost: ZERO });
        continue;
      }
      if (!row.verified) flags.push("price-unverified");
      const c = priceUsage(it, row, opts);
      if (!c.tierKnown) flags.push("tier-unknown");
      if (it.type === "fallback_message") flags.push("fallback");
      const scaled = scale(c, fast * geo);
      perIter.push({ model, type: it.type, cost: scaled });
      cost = add(cost, scaled);
    }
  } else {
    const row = lookupPrice(turn.model, atIso);
    if (!row) {
      flags.push(`unknown-model:${turn.model}`);
    } else {
      if (!row.verified) flags.push("price-unverified");
      const c = priceUsage(u, row, opts);
      if (!c.tierKnown) flags.push("tier-unknown");
      if (row.fastMult === undefined && fast !== 1) flags.push("fast-mode-unsupported-model");
      cost = scale(c, fast * geo);
    }
  }

  return {
    turnId: turn.id,
    model: turn.model,
    ...cost,
    fast,
    geo,
    iterations: perIter,
    flags: [...new Set(flags)],
  };
}

/** The three wrong methods the free scan compares against. Each returns total USD for a turn. */
export const naive = {
  /** every cache write priced at the 5-minute rate; what a tool that ignores cache_creation.ephemeral_1h reports */
  allWrites5m(turn: Turn): number {
    const row = lookupPrice(turn.model);
    if (!row) return 0;
    const u = turn.usage;
    const c = priceUsage(
      { ...u, cache_creation: { ephemeral_5m_input_tokens: u.cache_creation_input_tokens, ephemeral_1h_input_tokens: 0 } },
      row,
    );
    return c.total * (u.speed === "fast" ? 2 : 1) * (u.inference_geo === "us" ? US_GEO_MULT : 1);
  },
  /** input + output at base rates only; cache tokens ignored entirely */
  cacheBlind(turn: Turn): number {
    const row = lookupPrice(turn.model);
    if (!row) return 0;
    const u = turn.usage;
    return ((u.input_tokens / M) * row.input + (u.output_tokens / M) * row.output);
  },
  /** every cache token, read or write, priced as ordinary input */
  cacheAsInput(turn: Turn): number {
    const row = lookupPrice(turn.model);
    if (!row) return 0;
    const u = turn.usage;
    const tokens = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
    return (tokens / M) * row.input + (u.output_tokens / M) * row.output;
  },
};
