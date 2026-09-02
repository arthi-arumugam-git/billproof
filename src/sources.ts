import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseCodexSession } from "./readers/codex.js";
import { parseGeminiSession } from "./readers/gemini.js";
import type { Source, Turn } from "./types.js";

/**
 * Where each agent keeps its transcripts, and how to turn one file into turns.
 * Claude Code is read incrementally by cache.ts because its files run to hundreds of megabytes;
 * Codex and Gemini sessions are small enough to read whole, and their parsers need the full file
 * (a Codex turn's model comes from an earlier line; a Gemini session is one JSON document).
 */

export const SOURCES: Source[] = ["claude-code", "codex", "gemini-cli"];

export function defaultDir(source: Source): string {
  const home = homedir();
  switch (source) {
    case "claude-code": {
      const cfg = process.env.CLAUDE_CONFIG_DIR;
      return join(cfg && cfg.length > 0 ? cfg : join(home, ".claude"), "projects");
    }
    case "codex":
      return join(process.env.CODEX_HOME ?? join(home, ".codex"), "sessions");
    case "gemini-cli":
      return join(home, ".gemini", "tmp");
  }
}

export function parseSource(v: string | undefined): Source[] {
  if (!v || v === "all") return SOURCES;
  const map: Record<string, Source> = { claude: "claude-code", "claude-code": "claude-code", codex: "codex", openai: "codex", gemini: "gemini-cli", "gemini-cli": "gemini-cli" };
  const out: Source[] = [];
  for (const part of v.split(",")) {
    const s = map[part.trim().toLowerCase()];
    if (!s) throw new Error(`--source expects all, claude, codex or gemini (comma-separated); got ${part}`);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function isSessionFile(source: Source, name: string, path: string): boolean {
  switch (source) {
    case "claude-code":
      return name.endsWith(".jsonl");
    case "codex":
      return name.startsWith("rollout-") && name.endsWith(".jsonl");
    case "gemini-cli":
      return name.startsWith("session-") && name.endsWith(".json") && path.replace(/\\/g, "/").includes("/chats/");
  }
}

export async function findSessionFiles(source: Source, root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8) return;
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
      if (s.isDirectory()) {
        if (name === "node_modules" || name.startsWith(".tmp")) continue;
        await walk(p, depth + 1);
      } else if (isSessionFile(source, name, p)) out.push(p);
    }
  }
  await walk(root, 0);
  return out.sort();
}

/** Parse one whole Codex or Gemini file. Claude Code is handled by cache.ts / parse.ts. */
export async function parseWholeFile(source: Source, file: string): Promise<Turn[]> {
  const text = await readFile(file, "utf8");
  if (source === "codex") return parseCodexSession(text, file);
  if (source === "gemini-cli") return parseGeminiSession(text, file);
  throw new Error(`parseWholeFile does not handle ${source}`);
}
