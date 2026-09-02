import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseLine, type RawLine } from "./parse.js";
import type { Turn } from "./types.js";

/** Where Claude Code keeps transcripts. CLAUDE_CONFIG_DIR is honoured the way Claude Code honours it. */
export function defaultTranscriptDir(): string {
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  return join(cfg && cfg.length > 0 ? cfg : join(homedir(), ".claude"), "projects");
}

export async function findTranscripts(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let s;
      try {
        s = await stat(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) await walk(p);
      else if (name.endsWith(".jsonl")) out.push(p);
    }
  }
  await walk(root);
  return out.sort();
}

export interface ReadStats {
  files: number;
  lines: number;
  badLines: number;
}

/**
 * Stream every transcript line, yield the billable ones as Turns (still duplicated per content
 * block; run dedupe() afterwards). Malformed lines are counted, not fatal: a transcript being
 * written right now can end mid-line.
 */
export async function* readTurns(
  files: string[],
  stats: ReadStats = { files: 0, lines: 0, badLines: 0 },
): AsyncGenerator<Turn> {
  for (const file of files) {
    stats.files += 1;
    const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length === 0) continue;
      stats.lines += 1;
      let raw: RawLine;
      try {
        raw = JSON.parse(line) as RawLine;
      } catch {
        stats.badLines += 1;
        continue;
      }
      const t = parseLine(raw, file);
      if (t) yield t;
    }
  }
}
