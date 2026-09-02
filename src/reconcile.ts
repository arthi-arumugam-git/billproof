import { priceUsage } from "./pricing/price.js";
import { lookupPrice } from "./pricing/table.js";
import type { Turn } from "./types.js";

/**
 * Reconcile what this organisation was billed against what its own records say.
 *
 * Provider side, two Admin API endpoints (docs fetched 2026-09-02, response shapes copied from the
 * API reference; both are daily-bucketed and need an Admin key: "The Admin API is unavailable for
 * individual accounts"):
 *   GET /v1/organizations/usage_report/messages?starting_at&ending_at&group_by[]=model&bucket_width=1d
 *     -> { data: [{ starting_at, ending_at, results: [{ model, uncached_input_tokens,
 *          cache_creation: { ephemeral_1h_input_tokens, ephemeral_5m_input_tokens },
 *          cache_read_input_tokens, output_tokens, server_tool_use }] }], has_more, next_page }
 *   GET /v1/organizations/cost_report?starting_at&ending_at&group_by[]=description&bucket_width=1d
 *     -> { data: [{ starting_at, ending_at, results: [{ amount: "123.78912", currency: "USD",
 *          description: "Claude Opus 5 Usage - Input Tokens", cost_type, token_type, context_window, model? }] }] }
 *
 * Local side: either the Claude Code transcripts billproof already reads, or a JSON file of daily
 * rows exported from whatever metering you run. Both are aggregated to the same day+model grain
 * the provider uses, because that is the only grain the provider offers.
 *
 * Every row is labelled with the cause that best explains its difference, from a fixed list, so a
 * reader knows what to go and check rather than being handed a bare delta.
 */

export interface DailyUsage {
  day: string; // YYYY-MM-DD, UTC
  model: string;
  uncached: number;
  write5m: number;
  write1h: number;
  read: number;
  output: number;
}

export interface UsageBucket {
  starting_at: string;
  ending_at?: string;
  results: Array<{
    model?: string;
    uncached_input_tokens?: number;
    cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  }>;
}

export interface CostBucket {
  starting_at: string;
  ending_at?: string;
  results: Array<{ amount: string | number; currency?: string; description?: string; model?: string; cost_type?: string; token_type?: string }>;
}

export interface Paged<T> {
  data: T[];
  has_more?: boolean;
  next_page?: string | null;
}

const API = process.env.ANTHROPIC_BASE_URL?.replace(/\/$/, "") ?? "https://api.anthropic.com";

async function getAllPages<T>(url: URL, key: string, fetchImpl: typeof fetch): Promise<T[]> {
  const out: T[] = [];
  let page: string | null | undefined;
  for (let i = 0; i < 100; i++) {
    const u = new URL(url.toString());
    if (page) u.searchParams.set("page", page);
    const res = await fetchImpl(u, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "user-agent": "billproof (https://github.com/arthi-arumugam-git/billproof)" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${u.pathname} returned ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
    }
    const j = (await res.json()) as Paged<T>;
    out.push(...(j.data ?? []));
    if (!j.has_more || !j.next_page) break;
    page = j.next_page;
  }
  return out;
}

export async function fetchUsage(key: string, fromIso: string, toIso: string, fetchImpl: typeof fetch = fetch): Promise<UsageBucket[]> {
  const u = new URL(`${API}/v1/organizations/usage_report/messages`);
  u.searchParams.set("starting_at", `${fromIso}T00:00:00Z`);
  u.searchParams.set("ending_at", `${toIso}T00:00:00Z`);
  u.searchParams.append("group_by[]", "model");
  u.searchParams.set("bucket_width", "1d");
  u.searchParams.set("limit", "31");
  return getAllPages<UsageBucket>(u, key, fetchImpl);
}

export async function fetchCost(key: string, fromIso: string, toIso: string, fetchImpl: typeof fetch = fetch): Promise<CostBucket[]> {
  const u = new URL(`${API}/v1/organizations/cost_report`);
  u.searchParams.set("starting_at", `${fromIso}T00:00:00Z`);
  u.searchParams.set("ending_at", `${toIso}T00:00:00Z`);
  u.searchParams.append("group_by[]", "description");
  u.searchParams.set("bucket_width", "1d");
  u.searchParams.set("limit", "31");
  return getAllPages<CostBucket>(u, key, fetchImpl);
}

const day = (iso: string): string => iso.slice(0, 10);
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);

/** Provider usage buckets -> daily rows at the model grain billproof prices. */
export function usageToDaily(buckets: UsageBucket[]): DailyUsage[] {
  const out: DailyUsage[] = [];
  for (const b of buckets) {
    for (const r of b.results ?? []) {
      const cc = r.cache_creation ?? {};
      const w5 = n(cc.ephemeral_5m_input_tokens);
      const w1 = n(cc.ephemeral_1h_input_tokens);
      const creation = n(r.cache_creation_input_tokens);
      out.push({
        day: day(b.starting_at),
        model: r.model ?? "(unknown)",
        uncached: n(r.uncached_input_tokens),
        write5m: w5 || (w1 ? 0 : creation),
        write1h: w1,
        read: n(r.cache_read_input_tokens),
        output: n(r.output_tokens),
      });
    }
  }
  return out;
}

/** Local turns -> daily rows, UTC days, Anthropic only (that is what the org invoice covers). */
export function turnsToDaily(turns: Turn[]): DailyUsage[] {
  const byKey = new Map<string, DailyUsage>();
  for (const t of turns) {
    if (t.provider !== "anthropic") continue;
    const d = new Date(t.ts).toISOString().slice(0, 10);
    const key = `${d}|${t.model}`;
    const row = byKey.get(key) ?? { day: d, model: t.model, uncached: 0, write5m: 0, write1h: 0, read: 0, output: 0 };
    const u = t.usage;
    const cc = u.cache_creation;
    row.uncached += u.input_tokens;
    row.write5m += cc?.ephemeral_5m_input_tokens ?? (cc?.ephemeral_1h_input_tokens ? 0 : u.cache_creation_input_tokens);
    row.write1h += cc?.ephemeral_1h_input_tokens ?? 0;
    row.read += u.cache_read_input_tokens;
    row.output += u.output_tokens;
    byKey.set(key, row);
  }
  return [...byKey.values()];
}

/** Provider cost buckets -> billed USD per day, and per model where the description names one. */
export function costToDaily(buckets: CostBucket[]): { byDay: Map<string, number>; byDayModel: Map<string, number>; currency: string } {
  const byDay = new Map<string, number>();
  const byDayModel = new Map<string, number>();
  let currency = "USD";
  for (const b of buckets) {
    const d = day(b.starting_at);
    for (const r of b.results ?? []) {
      const amt = n(r.amount);
      if (r.currency) currency = r.currency;
      byDay.set(d, (byDay.get(d) ?? 0) + amt);
      const model = r.model ?? modelFromDescription(r.description ?? "");
      if (model) byDayModel.set(`${d}|${model}`, (byDayModel.get(`${d}|${model}`) ?? 0) + amt);
    }
  }
  return { byDay, byDayModel, currency };
}

/** "Claude Opus 5 Usage - Input Tokens" -> "claude-opus-5". Best effort; unmatched stays unattributed. */
export function modelFromDescription(desc: string): string | null {
  const m = /^Claude\s+([A-Za-z]+)\s+([\d.]+)/i.exec(desc);
  if (!m) return null;
  return `claude-${m[1].toLowerCase()}-${m[2].replace(/\./g, "-")}`;
}

export function priceDaily(r: DailyUsage): number {
  const row = lookupPrice(r.model);
  if (!row) return 0;
  return priceUsage(
    {
      input_tokens: r.uncached,
      output_tokens: r.output,
      cache_read_input_tokens: r.read,
      cache_creation_input_tokens: r.write5m + r.write1h,
      cache_creation: { ephemeral_5m_input_tokens: r.write5m, ephemeral_1h_input_tokens: r.write1h },
    },
    row,
  ).total;
}

export type ReconcileLabel =
  | "match"
  | "local-missing"
  | "local-extra"
  | "token-drift"
  | "cache-split-drift"
  | "price-drift"
  | "billed-vs-priced"
  | "unknown-model";

export interface ReconcileRow {
  day: string;
  model: string;
  local: DailyUsage | null;
  api: DailyUsage | null;
  localUsd: number;
  apiPricedUsd: number;
  billedUsd: number | null;
  tokenDeltaPct: number | null;
  labels: ReconcileLabel[];
  note: string;
}

export interface ReconcileReport {
  from: string;
  to: string;
  rows: ReconcileRow[];
  totals: { localUsd: number; apiPricedUsd: number; billedUsd: number; localTokens: number; apiTokens: number };
  byLabel: Record<string, number>;
  currency: string;
}

const tokensOf = (r: DailyUsage | null): number => (r ? r.uncached + r.write5m + r.write1h + r.read + r.output : 0);

export function reconcile(local: DailyUsage[], api: DailyUsage[], cost: ReturnType<typeof costToDaily>, from: string, to: string): ReconcileReport {
  const keys = new Set<string>();
  const L = new Map<string, DailyUsage>();
  const A = new Map<string, DailyUsage>();
  for (const r of local) {
    L.set(`${r.day}|${r.model}`, r);
    keys.add(`${r.day}|${r.model}`);
  }
  for (const r of api) {
    A.set(`${r.day}|${r.model}`, r);
    keys.add(`${r.day}|${r.model}`);
  }
  const rows: ReconcileRow[] = [];
  const byLabel: Record<string, number> = {};
  const totals = { localUsd: 0, apiPricedUsd: 0, billedUsd: 0, localTokens: 0, apiTokens: 0 };

  for (const key of [...keys].sort()) {
    const [d, model] = key.split("|");
    const l = L.get(key) ?? null;
    const a = A.get(key) ?? null;
    const localUsd = l ? priceDaily(l) : 0;
    const apiPricedUsd = a ? priceDaily(a) : 0;
    const billed = cost.byDayModel.get(key) ?? null;
    const labels: ReconcileLabel[] = [];
    let note = "";
    if (!lookupPrice(model)) {
      labels.push("unknown-model");
      note = "no price row for this model; both sides show $0";
    }
    if (!l && a) {
      labels.push("local-missing");
      note = "the organisation was billed for requests this machine's records do not contain: another machine, CI, an app, or a teammate";
    } else if (l && !a) {
      labels.push("local-extra");
      note = "local records have requests the organisation was not billed for: a subscription plan (Claude Code on Pro/Max is not API-billed), a different org's key, or a UTC day boundary";
    } else if (l && a) {
      const lt = tokensOf(l);
      const at = tokensOf(a);
      const pct = at > 0 ? (lt - at) / at : lt > 0 ? 1 : 0;
      const localGross = l.uncached + l.write5m + l.write1h + l.read;
      const apiGross = a.uncached + a.write5m + a.write1h + a.read;
      if (Math.abs(pct) > 0.01) {
        if (Math.abs(localGross - apiGross) / Math.max(apiGross, 1) <= 0.01 && Math.abs(l.output - a.output) / Math.max(a.output, 1) <= 0.01) {
          labels.push("cache-split-drift");
          note = "total input matches but the uncached / write / read split does not: a cache-convention mismatch (inclusive vs exclusive input, or 5m/1h tier)";
        } else {
          labels.push("token-drift");
          note = pct > 0 ? "local counts more tokens than the provider billed: duplicated lines, retries counted twice, or streaming deltas summed" : "local counts fewer tokens than billed: dropped events, a truncated log, or requests logged elsewhere";
        }
      } else if (Math.abs(localUsd - apiPricedUsd) > 0.01 && apiPricedUsd > 0 && Math.abs(localUsd - apiPricedUsd) / apiPricedUsd > 0.005) {
        labels.push("price-drift");
        note = "tokens match but the priced totals do not: a rate in the local price table is wrong for this day";
      }
      if (labels.length === 0) labels.push("match");
    }
    if (billed !== null && apiPricedUsd > 0 && Math.abs(billed - apiPricedUsd) / apiPricedUsd > 0.02) {
      labels.push("billed-vs-priced");
      note += (note ? "; " : "") + "what the provider billed differs from usage x list price: negotiated discount, credits, batch or priority tier, or web-search charges";
    }
    const tokenDeltaPct = l && a ? (tokensOf(a) > 0 ? (tokensOf(l) - tokensOf(a)) / tokensOf(a) : null) : null;
    rows.push({ day: d, model, local: l, api: a, localUsd, apiPricedUsd, billedUsd: billed, tokenDeltaPct, labels, note });
    for (const lb of labels) byLabel[lb] = (byLabel[lb] ?? 0) + 1;
    totals.localUsd += localUsd;
    totals.apiPricedUsd += apiPricedUsd;
    totals.localTokens += tokensOf(l);
    totals.apiTokens += tokensOf(a);
  }
  totals.billedUsd = [...cost.byDay.values()].reduce((s, v) => s + v, 0);
  return { from, to, rows, totals, byLabel, currency: cost.currency };
}

/** Read a JSON file of DailyUsage rows exported from your own metering, for teams that do not use Claude Code. */
export function parseLocalJson(text: string): DailyUsage[] {
  const raw = JSON.parse(text) as unknown;
  const arr = Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows;
  if (!Array.isArray(arr)) throw new Error("local JSON must be an array of rows or {rows: [...]}");
  return arr.map((r) => {
    const o = r as Record<string, unknown>;
    const d = String(o.day ?? o.date ?? "").slice(0, 10);
    const model = String(o.model ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !model) throw new Error(`local row needs day (YYYY-MM-DD) and model: ${JSON.stringify(r).slice(0, 120)}`);
    return {
      day: d,
      model,
      uncached: n(o.uncached ?? o.uncached_input_tokens ?? o.input_tokens),
      write5m: n(o.write5m ?? o.ephemeral_5m_input_tokens),
      write1h: n(o.write1h ?? o.ephemeral_1h_input_tokens),
      read: n(o.read ?? o.cache_read_input_tokens),
      output: n(o.output ?? o.output_tokens),
    };
  });
}
