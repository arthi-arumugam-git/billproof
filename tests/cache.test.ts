import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachePath, readTurnsCached, type CachedReadStats } from "../src/cache.js";
import { readLinesFrom } from "../src/lines.js";

const line = (id: string, ts = "2026-09-01T10:00:00.000Z") =>
  JSON.stringify({
    type: "assistant",
    uuid: `u-${id}`,
    requestId: `req_${id}`,
    sessionId: "s1",
    timestamp: ts,
    cwd: "/p",
    message: { id: `msg_${id}`, model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: "text" }] },
  }) + "\n";

const stats = (): CachedReadStats => ({ files: 0, lines: 0, badLines: 0, cachedFiles: 0, bytesRead: 0 });

describe("incremental transcript cache", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bp-"));
    process.env.BILLPROOF_HOME = dir;
  });
  afterEach(async () => {
    delete process.env.BILLPROOF_HOME;
    await rm(dir, { recursive: true, force: true });
  });

  it("reads only appended bytes on the second run and ignores a trailing partial line", async () => {
    const f = join(dir, "t.jsonl");
    await writeFile(f, line("a") + line("b"));
    const s1 = stats();
    const r1 = await readTurnsCached([f], s1);
    expect(r1.map((t) => t.id)).toEqual(["msg_a", "msg_b"]);
    expect(s1.cachedFiles).toBe(0);

    // append one complete line and one partial line (Claude Code mid-write)
    await appendFile(f, line("c") + line("d").slice(0, 40));
    const s2 = stats();
    const r2 = await readTurnsCached([f], s2);
    expect(r2.map((t) => t.id)).toEqual(["msg_a", "msg_b", "msg_c"]);
    expect(s2.cachedFiles).toBe(1);
    expect(s2.bytesRead).toBe(Buffer.byteLength(line("c")));
    expect(s2.badLines).toBe(0);

    // finish the partial line: only its remainder is read
    await appendFile(f, line("d").slice(40));
    const s3 = stats();
    const r3 = await readTurnsCached([f], s3);
    expect(r3.map((t) => t.id)).toEqual(["msg_a", "msg_b", "msg_c", "msg_d"]);
    expect(s3.bytesRead).toBe(Buffer.byteLength(line("d")));

    // untouched file: nothing read at all
    const s4 = stats();
    await readTurnsCached([f], s4);
    expect(s4.bytesRead).toBe(0);
    expect(s4.lines).toBe(0);
  });

  it("re-reads a file that shrank and forgets files that vanished", async () => {
    const f = join(dir, "t.jsonl");
    const g = join(dir, "gone.jsonl");
    await writeFile(f, line("a") + line("b"));
    await writeFile(g, line("z"));
    await readTurnsCached([f, g], stats());
    await writeFile(f, line("x"));
    await rm(g);
    const r = await readTurnsCached([f], stats());
    expect(r.map((t) => t.id)).toEqual(["msg_x"]);
    const cache = JSON.parse(await readFile(cachePath(), "utf8")) as { files: Record<string, unknown> };
    expect(Object.keys(cache.files)).toEqual([f]);
  });

  it("the cache never stores transcript content", async () => {
    const f = join(dir, "t.jsonl");
    const withText = JSON.stringify({
      type: "assistant",
      uuid: "u1",
      sessionId: "s1",
      timestamp: "2026-09-01T10:00:00.000Z",
      message: { id: "msg_1", model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: "text", text: "SECRET-PHRASE-42" }] },
    }) + "\n";
    await writeFile(f, withText);
    await readTurnsCached([f], stats());
    const raw = await readFile(cachePath(), "utf8");
    expect(raw).not.toContain("SECRET-PHRASE-42");
  });

  it("readLinesFrom handles CRLF and lines split across chunk boundaries", async () => {
    const f = join(dir, "crlf.jsonl");
    const big = "x".repeat(3 * 1024 * 1024);
    await writeFile(f, `{"a":1}\r\n{"b":"${big}"}\r\n{"c":3}`);
    const consumed = { bytes: 0 };
    const lines: string[] = [];
    for await (const l of readLinesFrom(f, 0, consumed)) lines.push(l);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0])).toEqual({ a: 1 });
    expect(JSON.parse(lines[1]).b.length).toBe(big.length);
    expect(consumed.bytes).toBe(Buffer.byteLength(`{"a":1}\r\n{"b":"${big}"}\r\n`));
  });
});
