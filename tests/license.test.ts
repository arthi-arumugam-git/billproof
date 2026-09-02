import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksLikeGumroadKey, validateGumroad, verifyOffline } from "../src/license.js";

/** Gumroad's documented shapes; the second is what a fresh key looks like. */
const GUM_KEY = "5E5A0F5C-C3B14D5C-B0F8C3D2-3F5C1A7B";
const UUID_KEY = "3f5c1a7b-1234-4abc-8def-0123456789ab";

const jsonRes = (body: unknown, status = 200): Response =>
  ({ status, ok: status < 400, json: async () => body }) as unknown as Response;

describe("gumroad key shapes", () => {
  it("accepts both documented shapes and rejects others", () => {
    expect(looksLikeGumroadKey(GUM_KEY)).toBe(true);
    expect(looksLikeGumroadKey(UUID_KEY)).toBe(true);
    expect(looksLikeGumroadKey("  " + UUID_KEY + "  ")).toBe(true);
    expect(looksLikeGumroadKey("bp1_abc.def")).toBe(false);
    expect(looksLikeGumroadKey("polar_xxx")).toBe(false);
    expect(looksLikeGumroadKey("")).toBe(false);
  });
});

describe("validateGumroad", () => {
  beforeEach(() => {
    process.env.BILLPROOF_GUMROAD_PRODUCT = "test-product";
    vi.resetModules();
  });
  afterEach(() => {
    delete process.env.BILLPROOF_GUMROAD_PRODUCT;
  });

  it("refuses to guess when no product is configured in the build", async () => {
    delete process.env.BILLPROOF_GUMROAD_PRODUCT;
    vi.resetModules();
    const { validateGumroad: fresh } = await import("../src/license.js?nocfg");
    const r = await (fresh as typeof validateGumroad)(GUM_KEY, async () => jsonRes({ success: true }));
    expect(r.ok).toBe(false);
  });

  it("accepts a successful purchase and returns the buyer email", async () => {
    const { validateGumroad: fresh } = await import("../src/license.js?ok");
    const r = await (fresh as typeof validateGumroad)(GUM_KEY, async (_u, init) => {
      // it must not inflate the uses counter on every weekly re-check
      expect(String((init as RequestInit).body)).toContain("increment_uses_count=false");
      return jsonRes({ success: true, uses: 1, purchase: { email: "buyer@example.com", refunded: false } });
    });
    expect(r).toEqual({ ok: true, customer: "buyer@example.com" });
  });

  it("rejects refunded, disputed and cancelled purchases even when success is true", async () => {
    const { validateGumroad: fresh } = await import("../src/license.js?bad");
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ refunded: true }, "refunded"],
      [{ chargebacked: true }, "disputed"],
      [{ disputed: true }, "disputed"],
      [{ subscription_cancelled_at: "2026-01-01" }, "no longer active"],
    ];
    for (const [purchase, expected] of cases) {
      const r = await (fresh as typeof validateGumroad)(GUM_KEY, async () => jsonRes({ success: true, purchase }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(expected);
    }
  });

  it("passes Gumroad's own message through on an unknown key", async () => {
    const { validateGumroad: fresh } = await import("../src/license.js?unknown");
    // this is the exact body the live endpoint returned on 2026-09-02 for a bogus key
    const r = await (fresh as typeof validateGumroad)(GUM_KEY, async () =>
      jsonRes({ success: false, message: "That license does not exist for the provided product." }, 404),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("That license does not exist for the provided product.");
  });

  it("marks a network failure as retryable so the offline grace can apply", async () => {
    const { validateGumroad: fresh } = await import("../src/license.js?net");
    const r = await (fresh as typeof validateGumroad)(GUM_KEY, async () => {
      throw new Error("getaddrinfo ENOTFOUND api.gumroad.com");
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.network).toBe(true);
  });
});

describe("offline signed keys", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bp-lic-"));
    process.env.BILLPROOF_HOME = dir;
  });
  afterEach(async () => {
    delete process.env.BILLPROOF_HOME;
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects a tampered payload and a non-key string", () => {
    expect(verifyOffline("bp1_notbase64.notasig").ok).toBe(false);
    expect(verifyOffline("hello").ok).toBe(false);
    expect(verifyOffline("bp1_").ok).toBe(false);
  });
});

describe("Dodo Payments keys", () => {
  const jsonOk = (body: unknown, status = 200): Response =>
    ({ status, ok: status < 400, json: async () => body }) as unknown as Response;

  it("trusts nothing about a key's shape beyond its length: Dodo keys carry no prefix, the product decides", async () => {
    const { looksLikeDodoKey } = await import("../src/license.js?dodoshape");
    expect(looksLikeDodoKey("ABCD-EFGH-IJKL-MNOP")).toBe(true);
    expect(looksLikeDodoKey("  ABCD-EFGH-IJKL  ")).toBe(true);
    expect(looksLikeDodoKey("short")).toBe(false);
    expect(looksLikeDodoKey("bp1_payload.signature")).toBe(false); // signed keys take the offline path
  });

  it("activation names the product the key was sold for, which is what decides the tier", async () => {
    const { activateDodo } = await import("../src/license.js?dodoproduct");
    const a = await activateDodo("K", "laptop", async () => jsonOk({ id: "inst_1", product: { product_id: "pdt_0NmiitBKHHwsTMzynyfr7", name: null } }));
    expect(a).toEqual({ ok: true, instanceId: "inst_1", productId: "pdt_0NmiitBKHHwsTMzynyfr7" });
  });

  it("accepts a valid key and reports Dodo's own message when it is not", async () => {
    const { validateDodo } = await import("../src/license.js?dodoval");
    await expect(validateDodo("K", async () => jsonOk({ valid: true }))).resolves.toEqual({ ok: true });
    // this is the exact body the live endpoint returned on 2026-09-02 for an unknown key
    const bad = await validateDodo("K", async () => jsonOk({ valid: false }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/not valid|no longer active/);
  });

  it("sends the key to the validate endpoint and nothing else", async () => {
    const { validateDodo } = await import("../src/license.js?dodobody");
    let seen: { url?: string; body?: unknown } = {};
    await validateDodo("MY-KEY", async (url, init) => {
      seen = { url: String(url), body: JSON.parse(String((init as RequestInit).body)) };
      return jsonOk({ valid: true });
    });
    expect(seen.url).toContain("/licenses/validate");
    expect(seen.body).toEqual({ license_key: "MY-KEY" });
  });

  it("treats a 5xx as retryable so the offline grace applies, but a 4xx as final", async () => {
    const { validateDodo } = await import("../src/license.js?dodo5xx");
    const down = await validateDodo("K", async () => jsonOk({}, 503));
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.network).toBe(true);
    const thrown = await validateDodo("K", async () => {
      throw new Error("ENOTFOUND live.dodopayments.com");
    });
    if (!thrown.ok) expect(thrown.network).toBe(true);
  });

  it("claims an activation slot and keeps the instance id so the machine can be released", async () => {
    const { activateDodo, deactivateDodo } = await import("../src/license.js?dodoact");
    const a = await activateDodo("K", "laptop", async (_u, init) => {
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({ license_key: "K", name: "laptop" });
      return jsonOk({ id: "inst_123" });
    });
    expect(a).toEqual({ ok: true, instanceId: "inst_123" });
    await expect(deactivateDodo("K", "inst_123", async () => jsonOk({}))).resolves.toBe(true);
  });

  it("reports an activation-limit refusal rather than pretending it worked", async () => {
    const { activateDodo } = await import("../src/license.js?dodolimit");
    const r = await activateDodo("K", "laptop", async () => jsonOk({ message: "activation limit reached" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/activation limit/);
  });
});
