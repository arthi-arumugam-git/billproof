#!/usr/bin/env node
import { receipt } from "./analyze/receipt.js";
import { scan, type GroupBy } from "./analyze/scan.js";
import { dedupe } from "./dedupe.js";
import { readTurnsCached, type CachedReadStats } from "./cache.js";
import { defaultTranscriptDir, findTranscripts } from "./discover.js";
import { renderReceiptHtml } from "./report/html.js";
import { renderReceipt, renderScan, usd } from "./report/terminal.js";
import { activate, checkLicense, licensePath } from "./license.js";
import type { Turn } from "./types.js";
import { writeFile } from "node:fs/promises";

const HELP = `billproof — prove your AI bill

Usage
  billproof [scan] [--dir <path>] [--since 7d|30d|YYYY-MM-DD] [--by day|model|project|skill|mcp|agent|session] [--json] [--no-cache]
  billproof receipt <session-id|--last|--today> [--all] [--json] [--html <file>]
  billproof sessions [--since ...]            list sessions with cost, newest first
  billproof activate <license-key>            unlock receipt
  billproof license                           show license status

Reads Claude Code transcripts from ~/.claude/projects (or CLAUDE_CONFIG_DIR). Nothing leaves your machine
except a license check when you run activate.`;

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
  const known = new Set(["scan", "receipt", "sessions", "activate", "license", "help"]);
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

async function loadTurns(dir: string, since: number, useCache: boolean): Promise<{ turns: Turn[]; stats: CachedReadStats }> {
  const files = await findTranscripts(dir);
  const stats: CachedReadStats = { files: 0, lines: 0, badLines: 0, cachedFiles: 0, bytesRead: 0 };
  const raw = await readTurnsCached(files, stats, { useCache });
  return { turns: dedupe(raw.filter((t) => t.ts >= since)), stats };
}

async function main(): Promise<number> {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || cmd === "help") {
    console.log(HELP);
    return 0;
  }
  const dir = typeof flags.dir === "string" ? flags.dir : defaultTranscriptDir();
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
  if (cmd === "license") {
    const st = await checkLicense();
    console.log(st.ok ? `Licensed (${st.source}${st.expiresAt ? `, valid to ${st.expiresAt}` : ""}). ${licensePath()}` : `No valid license (${st.reason}). Free scan works; receipt is paid.`);
    return 0;
  }

  const { turns, stats } = await loadTurns(dir, since, !flags["no-cache"]);
  if (turns.length === 0) {
    console.error(`No billed requests found under ${dir}${since ? " in that window" : ""}. Is this the machine that runs Claude Code?`);
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
      console.log(`\nreceipt is the paid part of billproof. Get a key at https://arthi-arumugam-git.github.io/billproof then run: billproof activate <key>`);
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
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
