import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ReadStats } from "./discover.js";
import { readLinesFrom } from "./lines.js";
import { parseLine, type RawLine } from "./parse.js";
import type { Turn } from "./types.js";

/**
 * Per-file cache of parsed turns. Transcripts are append-only JSONL and total gigabytes; parsed
 * turns are megabytes. Each entry remembers how many bytes of complete lines were consumed, so a
 * file that grew is read only from that offset. A file that shrank or was rewritten is re-read.
 * The cache stores only what Turn holds (usage, ids, timestamps, attribution), never content.
 */

const VERSION = 2;

interface Entry {
  /** bytes of complete lines consumed */
  bytes: number;
  mtimeMs: number;
  turns: Omit<Turn, "file">[];
}

interface CacheFile {
  version: number;
  files: Record<string, Entry>;
}

export function cachePath(): string {
  return join(process.env.BILLPROOF_HOME ?? join(homedir(), ".billproof"), "cache", `turns-v${VERSION}.json`);
}

async function loadCache(): Promise<CacheFile> {
  try {
    const c = JSON.parse(await readFile(cachePath(), "utf8")) as CacheFile;
    if (c.version === VERSION && c.files) return c;
  } catch {
    /* no cache yet */
  }
  return { version: VERSION, files: {} };
}

async function saveCache(c: CacheFile): Promise<void> {
  const p = cachePath();
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(c), "utf8");
  await rename(tmp, p);
}

export interface CachedReadStats extends ReadStats {
  cachedFiles: number;
  bytesRead: number;
}

async function readFileFrom(file: string, start: number, stats: CachedReadStats): Promise<{ turns: Omit<Turn, "file">[]; bytes: number }> {
  const consumed = { bytes: start };
  const turns: Omit<Turn, "file">[] = [];
  for await (const line of readLinesFrom(file, start, consumed)) {
    stats.lines += 1;
    let raw: RawLine;
    try {
      raw = JSON.parse(line) as RawLine;
    } catch {
      stats.badLines += 1;
      continue;
    }
    const t = parseLine(raw, file);
    if (t) {
      const { file: _f, ...rest } = t;
      turns.push(rest);
    }
  }
  stats.bytesRead += consumed.bytes - start;
  return { turns, bytes: consumed.bytes };
}

/** Yield raw (not yet deduplicated) turns for every file, reading only bytes not seen before. */
export async function readTurnsCached(
  files: string[],
  stats: CachedReadStats,
  opts: { useCache: boolean } = { useCache: true },
): Promise<Turn[]> {
  const cache = opts.useCache ? await loadCache() : { version: VERSION, files: {} };
  const out: Turn[] = [];
  const seen = new Set<string>();
  let dirty = false;
  for (const f of files) {
    seen.add(f);
    let s;
    try {
      s = await stat(f);
    } catch {
      continue;
    }
    stats.files += 1;
    const e = cache.files[f];
    if (e && s.size === e.bytes && s.mtimeMs === e.mtimeMs) {
      stats.cachedFiles += 1;
      for (const t of e.turns) out.push({ ...t, file: f });
      continue;
    }
    // grew: resume from the consumed offset. shrank or rewritten: start over.
    const resume = e && s.size >= e.bytes ? e : undefined;
    if (resume) {
      stats.cachedFiles += 1;
      for (const t of resume.turns) out.push({ ...t, file: f });
    }
    const { turns, bytes } = await readFileFrom(f, resume?.bytes ?? 0, stats);
    for (const t of turns) out.push({ ...t, file: f });
    if (opts.useCache) {
      cache.files[f] = { bytes, mtimeMs: s.mtimeMs, turns: [...(resume?.turns ?? []), ...turns] };
      dirty = true;
    }
  }
  if (opts.useCache) {
    for (const k of Object.keys(cache.files)) {
      if (!seen.has(k)) {
        delete cache.files[k];
        dirty = true;
      }
    }
    if (dirty) {
      try {
        await saveCache(cache);
      } catch {
        /* the cache is an optimisation; never fail a run for it */
      }
    }
  }
  return out;
}
