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
  provider: "anthropic" | "openai" | "gemini";
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
  provider: "anthropic",
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

/** OpenAI: cached input is a discount on input; writes are free except on 5.6 where they cost 1.25x. */
const O = (model: string, match: RegExp, input: number, output: number, opts: Partial<PriceRow> = {}): PriceRow => ({
  model,
  provider: "openai",
  match,
  effectiveFrom: "2025-01-01",
  input,
  output,
  cacheReadMult: 0.1,
  write5mMult: 1,
  write1hMult: 1,
  verified: true,
  ...opts,
});

const G = (model: string, match: RegExp, input: number, output: number, opts: Partial<PriceRow> = {}): PriceRow => ({
  model,
  provider: "gemini",
  match,
  effectiveFrom: "2025-01-01",
  input,
  output,
  cacheReadMult: 0.1,
  write5mMult: 1,
  write1hMult: 1,
  verified: true,
  ...opts,
});

/** OpenAI long-context tier, from the gpt-5.4 model page: ">272K input tokens ... 2x input and 1.5x output". */
const LC_OPENAI = { threshold: 272_000, inputMult: 2, outputMult: 1.5 };

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

  // ---- OpenAI, standard tier, USD per 1M tokens ----
  // Source: https://developers.openai.com/api/docs/pricing rendered 2026-09-02 (raw table saved in the
  // money-scout research folder). cacheReadMult is cached-input price / input price. Cache writes are
  // charged only on the 5.6 family; Codex logs do not report writes, so the multiplier is informational.
  // Long context: the gpt-5.4 model page states "prompts with >272K input tokens are priced at 2x input and
  // 1.5x output for the full session", which matches the table's long-context columns.
  O("gpt-5.6-sol", /gpt-5\.6-sol/, 4, 20, { cacheReadMult: 0.1, write5mMult: 1.25, longContext: LC_OPENAI }),
  O("gpt-5.6-terra", /gpt-5\.6-terra/, 2, 12, { cacheReadMult: 0.1, write5mMult: 1.25, longContext: LC_OPENAI }),
  O("gpt-5.6-luna", /gpt-5\.6-luna/, 0.2, 1.2, { cacheReadMult: 0.1, write5mMult: 1.25, longContext: LC_OPENAI }),
  O("gpt-5.6-cyber", /gpt-5\.6-cyber/, 12.5, 75, { cacheReadMult: 0.1, write5mMult: 1.25 }),
  O("gpt-5.5-pro", /gpt-5\.5-pro/, 30, 180, { cacheReadMult: 1, longContext: LC_OPENAI }),
  O("gpt-5.5", /gpt-5\.5(?![-.]\w)/, 5, 30, { cacheReadMult: 0.1, longContext: LC_OPENAI }),
  O("gpt-5.4-pro", /gpt-5\.4-pro/, 30, 180, { cacheReadMult: 1, longContext: LC_OPENAI }),
  O("gpt-5.4-mini", /gpt-5\.4-mini/, 0.75, 4.5, { cacheReadMult: 0.1 }),
  O("gpt-5.4-nano", /gpt-5\.4-nano/, 0.2, 1.25, { cacheReadMult: 0.1 }),
  O("gpt-5.4", /gpt-5\.4(?![-.]\w)/, 2.5, 15, { cacheReadMult: 0.1, longContext: LC_OPENAI }),
  O("gpt-5.3-codex", /gpt-5\.3-codex/, 1.75, 14, { cacheReadMult: 0.1 }),
  // gpt-5.2-codex is no longer on the page; priced at gpt-5.2's rate and flagged, never silently
  O("gpt-5.2-codex", /gpt-5\.2-codex/, 1.75, 14, { cacheReadMult: 0.1, verified: false }),
  O("gpt-5.2-pro", /gpt-5\.2-pro/, 21, 168, { cacheReadMult: 1 }),
  O("gpt-5.2", /gpt-5\.2(?![-.]\w)/, 1.75, 14, { cacheReadMult: 0.1 }),
  O("gpt-5.1-codex", /gpt-5\.1-codex/, 1.25, 10, { cacheReadMult: 0.1, verified: false }),
  O("gpt-5.1", /gpt-5\.1(?![-.]\w)/, 1.25, 10, { cacheReadMult: 0.1 }),
  O("gpt-5-codex", /gpt-5-codex/, 1.25, 10, { cacheReadMult: 0.1, verified: false }),
  O("gpt-5-pro", /gpt-5-pro/, 15, 120, { cacheReadMult: 1 }),
  O("gpt-5-mini", /gpt-5-mini/, 0.25, 2, { cacheReadMult: 0.1 }),
  O("gpt-5-nano", /gpt-5-nano/, 0.05, 0.4, { cacheReadMult: 0.1 }),
  O("gpt-5", /gpt-5(?![-.]\w)/, 1.25, 10, { cacheReadMult: 0.1 }),
  O("gpt-4.1-mini", /gpt-4\.1-mini/, 0.4, 1.6, { cacheReadMult: 0.25 }),
  O("gpt-4.1-nano", /gpt-4\.1-nano/, 0.1, 0.4, { cacheReadMult: 0.25 }),
  O("gpt-4.1", /gpt-4\.1(?![-.]\w)/, 2, 8, { cacheReadMult: 0.25 }),
  O("gpt-4o-mini", /gpt-4o-mini/, 0.15, 0.6, { cacheReadMult: 0.5 }),
  O("gpt-4o", /gpt-4o(?![-.]\w)/, 2.5, 10, { cacheReadMult: 0.5 }),
  O("o4-mini", /^o4-mini/, 1.1, 4.4, { cacheReadMult: 0.25 }),
  O("o3-pro", /^o3-pro/, 20, 80, { cacheReadMult: 1 }),
  O("o3-mini", /^o3-mini/, 1.1, 4.4, { cacheReadMult: 0.5 }),
  O("o3", /^o3(?![-.]\w)/, 2, 8, { cacheReadMult: 0.25 }),
  O("o1-pro", /^o1-pro/, 150, 600, { cacheReadMult: 1 }),
  O("o1", /^o1(?![-.]\w)/, 15, 60, { cacheReadMult: 0.5 }),

  // ---- Gemini Developer API, paid tier, USD per 1M tokens ----
  // Source: https://ai.google.dev/gemini-api/docs/pricing rendered 2026-09-02. "Output price (including thinking
  // tokens)", so thoughts are output. "Context caching price" is the cached-input rate. Gemini 3.1 Pro has a
  // 200k tier: input $2 -> $4, output $12 -> $18, caching $0.20 -> $0.40.
  G("gemini-3.1-pro", /gemini-3\.1-pro/, 2, 12, { cacheReadMult: 0.1, longContext: { threshold: 200_000, inputMult: 2, outputMult: 1.5 } }),
  // gemini-3-pro-preview is not on the current page; priced at 3.1 Pro's rate and flagged
  G("gemini-3-pro", /gemini-3-pro/, 2, 12, { cacheReadMult: 0.1, longContext: { threshold: 200_000, inputMult: 2, outputMult: 1.5 }, verified: false }),
  G("gemini-3-flash", /gemini-3-flash/, 0.5, 3, { cacheReadMult: 0.1 }),
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
