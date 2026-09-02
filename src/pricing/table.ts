/**
 * Anthropic list prices in USD per million tokens.
 *
 * Source for every row marked verified: https://platform.claude.com/docs/en/about-claude/pricing
 * fetched 2026-09-02 (raw copy kept in the money-scout research folder as build-anthropic-pricing.md).
 * Rows marked verified:false are legacy models whose prices were not on that page; the engine flags
 * any turn priced with them as "price-unverified" so a report never silently relies on them.
 *
 * Multipliers on the same page:
 *   5-minute cache write 1.25x base input; 1-hour cache write 2x base input;
 *   cache read 0.1x base input (0.025x on Fable 5.1 and Mythos 5.1);
 *   fast mode (Opus 5 / Opus 4.8 only) doubles every category;
 *   inference_geo "us" on Claude 4.6+ multiplies every category by 1.1;
 *   Claude 4.6+ bills the full 1M context at standard rates.
 */

export interface PriceRow {
  /** canonical family id used in reports */
  model: string;
  /** matches model ids including dated snapshots and Bedrock/Vertex spellings */
  match: RegExp;
  /** ISO date from which this row applies; earlier turns fall through to older rows if any */
  effectiveFrom: string;
  /** USD per MTok */
  input: number;
  output: number;
  cacheReadMult: number;
  write5mMult: number;
  write1hMult: number;
  /** fast-mode rates are exactly 2x on the page; kept explicit so a future asymmetric change is one edit */
  fastMult?: number;
  /** pre-4.6 1M-context premium above the threshold (tokens) */
  longContext?: { threshold: number; inputMult: number; outputMult: number };
  verified: boolean;
}

const R = (
  model: string,
  match: RegExp,
  input: number,
  output: number,
  opts: Partial<PriceRow> = {},
): PriceRow => ({
  model,
  match,
  effectiveFrom: "2025-01-01",
  input,
  output,
  cacheReadMult: 0.1,
  write5mMult: 1.25,
  write1hMult: 2,
  verified: true,
  ...opts,
});

/** Ordered most-specific first. First regex match wins. */
export const PRICE_TABLE: PriceRow[] = [
  R("claude-fable-5-1", /fable-5-1/, 10, 50, { cacheReadMult: 0.025 }),
  R("claude-mythos-5-1", /mythos-5-1/, 10, 50, { cacheReadMult: 0.025 }),
  R("claude-fable-5", /fable-5(?!-1)/, 10, 50),
  R("claude-mythos-5", /mythos-5(?!-1)/, 10, 50),
  R("claude-opus-5", /opus-5/, 5, 25, { fastMult: 2 }),
  R("claude-opus-4-8", /opus-4-8/, 5, 25, { fastMult: 2 }),
  R("claude-opus-4-7", /opus-4-7/, 5, 25),
  R("claude-opus-4-6", /opus-4-6/, 5, 25),
  R("claude-opus-4-5", /opus-4-5/, 5, 25),
  R("claude-opus-4-1", /opus-4-1/, 15, 75),
  // "opus-4" but not "opus-4-1" / "opus-4-5"; a date suffix like "-20250514" is allowed
  R("claude-opus-4", /opus-4(?!-\d(?!\d))(?!\.\d)/, 15, 75),
  R("claude-sonnet-5", /sonnet-5/, 2, 10),
  R("claude-sonnet-4-6", /sonnet-4-6/, 3, 15),
  R("claude-sonnet-4-5", /sonnet-4-5/, 3, 15, {
    longContext: { threshold: 200_000, inputMult: 2, outputMult: 1.5 },
    verified: false,
  }),
  R("claude-sonnet-4", /sonnet-4(?!-\d(?!\d))(?!\.\d)/, 3, 15, {
    longContext: { threshold: 200_000, inputMult: 2, outputMult: 1.5 },
    verified: false,
  }),
  R("claude-haiku-4-5", /haiku-4-5/, 1, 5),
  R("claude-haiku-3-5", /(haiku-3-5|3-5-haiku)/, 0.8, 4),
  // Legacy, not on the 2026-09-02 page. Kept so old transcripts still price, always flagged.
  R("claude-3-7-sonnet", /3-7-sonnet/, 3, 15, { verified: false }),
  R("claude-3-5-sonnet", /3-5-sonnet/, 3, 15, { verified: false }),
  R("claude-3-opus", /3-opus/, 15, 75, { verified: false }),
  R("claude-3-haiku", /3-haiku/, 0.25, 1.25, { verified: false }),
];

/** Multiplier for inference_geo === "us" on Claude 4.6 and later (page: "Data residency pricing"). */
export const US_GEO_MULT = 1.1;

export function lookupPrice(model: string, atIso?: string): PriceRow | undefined {
  const at = atIso ?? "9999-12-31";
  for (const row of PRICE_TABLE) {
    if (row.match.test(model) && row.effectiveFrom <= at) return row;
  }
  return undefined;
}
