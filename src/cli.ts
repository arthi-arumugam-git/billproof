#!/usr/bin/env node
import { receipt } from "./analyze/receipt.js";
import { scan, type GroupBy } from "./analyze/scan.js";
import { dedupe } from "./dedupe.js";
import { readTurnsCached, readWholeFilesCached, type CachedReadStats } from "./cache.js";
import { findTranscripts } from "./discover.js";
import { defaultDir, findSessionFiles, parseSource } from "./sources.js";
import { renderReceiptHtml } from "./report/html.js";
import { renderReceipt, renderReconcile, renderScan, usd } from "./report/terminal.js";
import { activate, checkLicense, deactivate, licensePath } from "./license.js";
import { costToDaily, fetchCost, fetchUsage, parseLocalJson, reconcile, turnsToDaily, usageToDaily } from "./reconcile.js";
import type { Turn } from "./types.js";
import { readFile, writeFile } from "node:fs/promises";

const SITE = "https://arthi-arumugam-git.github.io/billproof";
const TEAM_PRICE_USD = 199;

const HELP = `billproof — prove your AI bill

Usage
  billproof [scan] [--source all|claude|codex|gemini] [--dir <path>] [--since 7d|30d|YYYY-MM-DD]
                   [--by day|model|project|skill|mcp|agent|session|provider|source] [--json] [--no-cache]
  billproof receipt <session-id|--last|--today> [--all] [--json] [--html <file>]
  billproof sessions [--since ...]            list sessions with cost, newest first
  billproof activate <license-key>            unlock receipt on this machine
  billproof license                           show license status
  billproof deactivate                        release this machine's licence slot
  billproof reconcile --from YYYY-MM-DD --to YYYY-MM-DD [--local rows.json] [--json]
                                              Team: local records against the Anthropic usage and cost reports

Reads Claude Code (~/.claude/projects), Codex (~/.codex/sessions) and Gemini CLI (~/.gemini/tmp) sessions.
--dir overrides the directory for a single --source. Nothing leaves your machine except a license check;
reconcile additionally calls the Anthropic Admin API with ANTHROPIC_ADMIN_KEY.`;

interface Args {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2);
      if (inline !== undefined) flags[k] = inline;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--") && !["json", "all", "today", "last", "help", "no-cache"].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  const known = new Set(["scan", "receipt", "sessions", "activate", "license", "deactivate", "reconcile", "help"]);
  const cmd = positional.length && known.has(positional[0]) ? positional.shift()! : "scan";
  return { cmd, positional, flags };
}

function sinceMs(v: string | boolean | undefined): number {
  if (!v || v === true) return 0;
  const m = /^(\d+)([dhw])$/.exec(v);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2] === "d" ? 86_400_000 : m[2] === "h" ? 3_600_000 : 7 * 86_400_000;
    return Date.now() - n * unit;
  }
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`--since expects 7d, 30d, 12h, 2w or YYYY-MM-DD; got ${v}`);
  return t;
}

const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);
const dayShift = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function loadTurns(
  sources: ReturnType<typeof parseSource>,
  dirOverride: string | undefined,
  since: number,
  useCache: boolean,
): Promise<{ turns: Turn[]; stats: CachedReadStats; dirs: string[] }> {
  const stats: CachedReadStats = { files: 0, lines: 0, badLines: 0, cachedFiles: 0, bytesRead: 0 };
  const raw: Turn[] = [];
  const dirs: string[] = [];
  for (const source of sources) {
    const dir = dirOverride && sources.length === 1 ? dirOverride : defaultDir(source);
    dirs.push(dir);
    if (source === "claude-code") {
      const files = await findTranscripts(dir);
      for (const t of await readTurnsCached(files, stats, { useCache })) raw.push(t);
    } else {
      const files = await findSessionFiles(source, dir);
      for (const t of await readWholeFilesCached(source, files, stats, { useCache })) raw.push(t);
    }
  }
  return { turns: dedupe(raw.filter((t) => t.ts >= since)), stats, dirs };
}

async function main(): Promise<number> {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || cmd === "help") {
    console.log(HELP);
    return 0;
  }
  const sources = parseSource(typeof flags.source === "string" ? flags.source : undefined);
  const dirOverride = typeof flags.dir === "string" ? flags.dir : undefined;
  if (dirOverride && sources.length > 1) {
    console.error("--dir needs a single --source (claude, codex or gemini) so it is clear which layout the directory has.");
    return 2;
  }
  const since = sinceMs(flags.since);

  if (cmd === "activate") {
    const key = positional[0];
    if (!key) {
      console.error("usage: billproof activate <license-key>");
      return 2;
    }
    const r = await activate(key);
    console.log(r.ok ? `Activated. Stored at ${licensePath()}` : `Could not activate: ${r.reason}`);
    return r.ok ? 0 : 1;
  }
  if (cmd === "deactivate") {
    const r = await deactivate();
    console.log(r.ok ? "Released. This machine no longer holds a licence slot." : `Could not release: ${r.reason}`);
    return r.ok ? 0 : 1;
  }
  if (cmd === "license") {
    const st = await checkLicense();
    console.log(st.ok ? `Licensed (${st.source}, ${st.tier ?? "solo"} tier${st.expiresAt ? `, valid to ${st.expiresAt}` : ""}). ${licensePath()}` : `No valid license (${st.reason}). Free scan works; receipt and reconcile are paid.`);
    return 0;
  }

  if (cmd === "reconcile") {
    const lic = await checkLicense();
    if (!lic.ok || lic.tier !== "team") {
      console.error(
        `reconcile is the Team tier of billproof ($${TEAM_PRICE_USD} once per organisation). Get a key at ${SITE}#team then run: billproof activate <key>` +
          (lic.ok ? " (the key on this machine is the solo tier)" : ""),
      );
      return 3;
    }
    const adminKey = process.env.ANTHROPIC_ADMIN_KEY?.trim();
    if (!adminKey) {
      console.error("reconcile needs ANTHROPIC_ADMIN_KEY: an Admin API key (sk-ant-admin...) from console.anthropic.com/settings/admin-keys. Admin keys exist for organisations only; individual accounts have no usage or cost report.");
      return 2;
    }
    const to = typeof flags.to === "string" ? flags.to : new Date().toISOString().slice(0, 10);
    const from = typeof flags.from === "string" ? flags.from : dayShift(to, -30);
    if (!isDay(from) || !isDay(to) || from > to) {
      console.error("--from and --to take YYYY-MM-DD with from on or before to");
      return 2;
    }
    const toExclusive = dayShift(to, 1);
    let local;
    if (typeof flags.local === "string") local = parseLocalJson(await readFile(flags.local, "utf8"));
    else {
      const loaded = await loadTurns(sources, dirOverride, Date.parse(`${from}T00:00:00Z`), !flags["no-cache"]);
      local = turnsToDaily(loaded.turns.filter((t) => t.ts < Date.parse(`${toExclusive}T00:00:00Z`)));
    }
    const [usage, cost] = await Promise.all([fetchUsage(adminKey, from, toExclusive), fetchCost(adminKey, from, toExclusive)]);
    const r = reconcile(local, usageToDaily(usage), costToDaily(cost), from, to);
    if (flags.json) console.log(JSON.stringify(r, null, 2));
    else console.log(renderReconcile(r));
    return 0;
  }

  const { turns, stats, dirs } = await loadTurns(sources, dirOverride, since, !flags["no-cache"]);
  const dir = dirs.join(", ");
  if (turns.length === 0) {
    console.error(`No billed requests found under ${dir}${since ? " in that window" : ""}. Is this the machine that runs the agent?`);
    return 1;
  }

  if (cmd === "scan") {
    const by = (typeof flags.by === "string" ? flags.by : "day") as GroupBy;
    const s = scan(turns, by);
    if (flags.json) console.log(JSON.stringify({ ...s, stats }, null, 2));
    else console.log(renderScan(s, by, dir));
    if (stats.badLines) console.error(`(${stats.badLines} unreadable lines skipped)`);
    return 0;
  }

  if (cmd === "sessions") {
    const s = scan(turns, "session");
    const rows = s.groups.map((g) => {
      const first = turns.find((t) => t.sessionId === g.key);
      return { session: g.key, project: first?.cwd ?? "", started: first ? new Date(first.ts).toISOString() : "", requests: g.turns, cost: g.total };
    });
    rows.sort((a, b) => b.started.localeCompare(a.started));
    if (flags.json) console.log(JSON.stringify(rows, null, 2));
    else for (const r of rows.slice(0, 50)) console.log(`${r.started.slice(0, 16).replace("T", " ")}  ${usd(r.cost).padStart(10)}  ${String(r.requests).padStart(5)} req  ${r.session}  ${r.project}`);
    return 0;
  }

  if (cmd === "receipt") {
    const lic = await checkLicense();
    if (!lic.ok) {
      const s = scan(turns, "session");
      console.log(renderScan(s, "session", dir));
      console.log(`\nreceipt is the paid part of billproof. Get a key at ${SITE}#price then run: billproof activate <key>`);
      return 3;
    }
    let sessionId = positional[0];
    if (!sessionId || flags.last || flags.today) {
      const sorted = [...turns].sort((a, b) => b.ts - a.ts);
      sessionId = sorted[0].sessionId;
    }
    const r = receipt(turns, sessionId);
    if (r.turns === 0) {
      console.error(`No session ${sessionId} under ${dir}. Try: billproof sessions`);
      return 1;
    }
    if (flags.json) console.log(JSON.stringify(r, (k, v) => (k === "turn" ? { id: v.id, ts: v.ts, model: v.model, usage: v.usage, agentId: v.agentId, sidechain: v.sidechain } : v), 2));
    else console.log(renderReceipt(r, { all: Boolean(flags.all) }));
    if (typeof flags.html === "string") {
      await writeFile(flags.html, renderReceiptHtml(r), "utf8");
      console.log(`wrote ${flags.html}`);
    }
    return 0;
  }

  console.error(HELP);
  return 2;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
