import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Three kinds of key are accepted, tried in this order:
 *  - offline keys `bp1_<payload>.<signature>` signed with the project's Ed25519 key (issued by hand),
 *  - Gumroad license keys (UUID-shaped), validated against Gumroad's public verify endpoint, and
 *  - Polar license keys, validated against Polar's customer-portal endpoint.
 * Once validated, the key is stored locally and re-checked weekly with a 30-day offline grace.
 * This is a courtesy gate for an open-source tool, not DRM.
 */

export const POLAR_ORG_ID = process.env.BILLPROOF_POLAR_ORG ?? "";
const POLAR_VALIDATE = "https://api.polar.sh/v1/customer-portal/license-keys/validate";

/**
 * Gumroad product id for billproof. Gumroad issues one license key per sale and emails it to the
 * buyer automatically, so no server of ours is involved in delivery.
 * Verified 2026-09-02: POST https://api.gumroad.com/v2/licenses/verify with product_id + license_key
 * needs no access token and answers {"success":false,"message":"That license does not exist for the
 * provided product."} for an unknown key.
 */
export const GUMROAD_PRODUCT_ID = process.env.BILLPROOF_GUMROAD_PRODUCT ?? "";
const GUMROAD_VERIFY = "https://api.gumroad.com/v2/licenses/verify";
/** Gumroad keys look like 8-4-4-4-12 uppercase hex groups. */
const GUMROAD_KEY = /^[0-9A-F]{8}-[0-9A-F]{8}-[0-9A-F]{8}-[0-9A-F]{8}$|^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/** SPKI PEM of the Ed25519 public key that signs offline keys. The private half never ships. */
export const OFFLINE_PUBLIC_KEY_PEM = process.env.BILLPROOF_PUBKEY_PEM ?? `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAB8u3eSFduRCpRLP0bvtdthDv1bSt7/gdXRPyop7wVQs=
-----END PUBLIC KEY-----`;

const REVALIDATE_MS = 7 * 86_400_000;
const GRACE_MS = 30 * 86_400_000;

export interface StoredLicense {
  key: string;
  source: "polar" | "gumroad" | "signed" | "env";
  validatedAt: string;
  expiresAt?: string;
  customer?: string;
}

export function licensePath(): string {
  return join(process.env.BILLPROOF_HOME ?? join(homedir(), ".billproof"), "license.json");
}

const b64url = (s: string): Buffer => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export interface OfflinePayload {
  sub: string;
  plan: string;
  iat: string;
  exp?: string;
}

export function verifyOffline(key: string): { ok: true; payload: OfflinePayload } | { ok: false; reason: string } {
  if (!key.startsWith("bp1_")) return { ok: false, reason: "not an offline key" };
  const body = key.slice(4);
  const dot = body.lastIndexOf(".");
  if (dot < 0) return { ok: false, reason: "malformed key" };
  const payloadB64 = body.slice(0, dot);
  const sig = b64url(body.slice(dot + 1));
  let pub;
  try {
    pub = createPublicKey(OFFLINE_PUBLIC_KEY_PEM);
  } catch {
    return { ok: false, reason: "public key unavailable" };
  }
  const ok = cryptoVerify(null, Buffer.from(payloadB64, "utf8"), pub, sig);
  if (!ok) return { ok: false, reason: "signature does not verify" };
  let payload: OfflinePayload;
  try {
    payload = JSON.parse(b64url(payloadB64).toString("utf8")) as OfflinePayload;
  } catch {
    return { ok: false, reason: "payload is not JSON" };
  }
  if (payload.exp && Date.parse(payload.exp) < Date.now()) return { ok: false, reason: `expired ${payload.exp}` };
  return { ok: true, payload };
}

interface GumroadResponse {
  success?: boolean;
  message?: string;
  uses?: number;
  purchase?: {
    email?: string;
    refunded?: boolean;
    disputed?: boolean;
    chargebacked?: boolean;
    subscription_cancelled_at?: string | null;
    subscription_failed_at?: string | null;
  };
}

export function looksLikeGumroadKey(key: string): boolean {
  return GUMROAD_KEY.test(key.trim());
}

/**
 * Verify a Gumroad license key. `increment_uses_count=false` keeps the counter meaningful as a
 * device count rather than a run count: billproof re-validates weekly and must not inflate it.
 * A refunded, disputed or charged-back purchase is treated as no licence.
 */
export async function validateGumroad(
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; customer?: string } | { ok: false; reason: string; network?: boolean }> {
  if (!GUMROAD_PRODUCT_ID) return { ok: false, reason: "Gumroad product not configured in this build" };
  let res: Response;
  try {
    res = await fetchImpl(GUMROAD_VERIFY, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ product_id: GUMROAD_PRODUCT_ID, license_key: key, increment_uses_count: "false" }).toString(),
    });
  } catch (e) {
    return { ok: false, reason: `network: ${e instanceof Error ? e.message : String(e)}`, network: true };
  }
  let data: GumroadResponse;
  try {
    data = (await res.json()) as GumroadResponse;
  } catch {
    return { ok: false, reason: `Gumroad returned ${res.status} with no JSON`, network: res.status >= 500 };
  }
  if (!data.success) return { ok: false, reason: data.message ?? `Gumroad returned ${res.status}` };
  const p = data.purchase ?? {};
  if (p.refunded) return { ok: false, reason: "purchase was refunded" };
  if (p.disputed || p.chargebacked) return { ok: false, reason: "purchase was disputed" };
  if (p.subscription_cancelled_at || p.subscription_failed_at) return { ok: false, reason: "subscription is no longer active" };
  return { ok: true, customer: p.email };
}

interface PolarResponse {
  status?: string;
  expires_at?: string | null;
  customer?: { email?: string } | null;
  detail?: unknown;
}

export async function validatePolar(key: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; expiresAt?: string; customer?: string } | { ok: false; reason: string; network?: boolean }> {
  if (!POLAR_ORG_ID) return { ok: false, reason: "Polar organisation not configured in this build" };
  let res: Response;
  try {
    res = await fetchImpl(POLAR_VALIDATE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, organization_id: POLAR_ORG_ID }),
    });
  } catch (e) {
    return { ok: false, reason: `network: ${e instanceof Error ? e.message : String(e)}`, network: true };
  }
  if (res.status === 404) return { ok: false, reason: "key not found" };
  if (!res.ok) return { ok: false, reason: `Polar returned ${res.status}` };
  const data = (await res.json()) as PolarResponse;
  if (data.status !== "granted") return { ok: false, reason: `key status ${data.status ?? "unknown"}` };
  if (data.expires_at && Date.parse(data.expires_at) < Date.now()) return { ok: false, reason: `expired ${data.expires_at}` };
  return { ok: true, expiresAt: data.expires_at ?? undefined, customer: data.customer?.email ?? undefined };
}

async function store(lic: StoredLicense): Promise<void> {
  const p = licensePath();
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, JSON.stringify(lic, null, 2), "utf8");
}

async function load(): Promise<StoredLicense | null> {
  try {
    return JSON.parse(await readFile(licensePath(), "utf8")) as StoredLicense;
  } catch {
    return null;
  }
}

export async function activate(key: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  key = key.trim();
  if (key.startsWith("bp1_")) {
    const v = verifyOffline(key);
    if (!v.ok) return v;
    await store({ key, source: "signed", validatedAt: new Date().toISOString(), expiresAt: v.payload.exp, customer: v.payload.sub });
    return { ok: true };
  }
  if (looksLikeGumroadKey(key)) {
    const g = await validateGumroad(key);
    if (g.ok) {
      await store({ key, source: "gumroad", validatedAt: new Date().toISOString(), customer: g.customer });
      return { ok: true };
    }
    // A real Gumroad rejection is final. Only fall through to Polar when this build has no
    // Gumroad product configured, so a Polar-shaped key is not refused by the wrong validator.
    if (GUMROAD_PRODUCT_ID) return { ok: false, reason: g.reason };
  }
  const v = await validatePolar(key);
  if (!v.ok) return { ok: false, reason: v.reason };
  await store({ key, source: "polar", validatedAt: new Date().toISOString(), expiresAt: v.expiresAt, customer: v.customer });
  return { ok: true };
}

export interface LicenseStatus {
  ok: boolean;
  source?: StoredLicense["source"];
  expiresAt?: string;
  reason?: string;
}

export async function checkLicense(): Promise<LicenseStatus> {
  const envKey = process.env.BILLPROOF_LICENSE?.trim();
  const lic = envKey ? { key: envKey, source: "env" as const, validatedAt: "1970-01-01T00:00:00Z" } : await load();
  if (!lic) return { ok: false, reason: "no license stored" };

  if (lic.key.startsWith("bp1_")) {
    const v = verifyOffline(lic.key);
    return v.ok ? { ok: true, source: lic.source === "env" ? "env" : "signed", expiresAt: v.payload.exp } : { ok: false, reason: v.reason };
  }

  const age = Date.now() - Date.parse(lic.validatedAt);
  if (age < REVALIDATE_MS) return { ok: true, source: lic.source, expiresAt: lic.expiresAt };

  if (lic.source === "gumroad" || (lic.source === "env" && looksLikeGumroadKey(lic.key))) {
    const g = await validateGumroad(lic.key);
    if (g.ok) {
      if (lic.source !== "env") await store({ ...lic, validatedAt: new Date().toISOString(), customer: g.customer });
      return { ok: true, source: lic.source };
    }
    if (g.network && age < GRACE_MS) return { ok: true, source: lic.source, reason: "offline; within grace" };
    return { ok: false, reason: g.reason };
  }

  const v = await validatePolar(lic.key);
  if (v.ok) {
    if (lic.source !== "env") await store({ ...lic, validatedAt: new Date().toISOString(), expiresAt: v.expiresAt, customer: v.customer });
    return { ok: true, source: lic.source, expiresAt: v.expiresAt };
  }
  if (v.network && age < GRACE_MS) return { ok: true, source: lic.source, expiresAt: lic.expiresAt, reason: "offline; within grace" };
  return { ok: false, reason: v.reason };
}
