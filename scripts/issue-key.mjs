#!/usr/bin/env node
// Issue an offline billproof license key. Usage:
//   node scripts/issue-key.mjs <customer-email-or-id> [--plan receipt] [--exp 2027-12-31]
// Reads the Ed25519 private key from BILLPROOF_PRIVKEY (path) or ~/.billproof-keys/private.pem. Never commit that file.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const args = process.argv.slice(2);
const sub = args.find((a) => !a.startsWith("--"));
if (!sub) { console.error("usage: issue-key.mjs <customer> [--plan receipt] [--exp YYYY-MM-DD]"); process.exit(2); }
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const pem = readFileSync(process.env.BILLPROOF_PRIVKEY ?? join(homedir(), ".billproof-keys", "private.pem"), "utf8");
const payload = { sub, plan: opt("plan", "receipt"), iat: new Date().toISOString().slice(0, 10) };
const exp = opt("exp"); if (exp) payload.exp = exp;
const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const body = b64url(JSON.stringify(payload));
const sig = sign(null, Buffer.from(body, "utf8"), createPrivateKey(pem));
console.log(`bp1_${body}.${b64url(sig)}`);
