import { createReadStream } from "node:fs";

/**
 * Read complete lines from a byte offset, tracking how many bytes were consumed by complete lines.
 * Transcripts are append-only JSONL, so a later run can resume exactly where this one stopped.
 * A trailing partial line (Claude Code mid-write) is not yielded and not counted as consumed.
 */
export async function* readLinesFrom(
  file: string,
  start: number,
  consumed: { bytes: number },
): AsyncGenerator<string> {
  const stream = createReadStream(file, { start, highWaterMark: 1 << 20 });
  let carry: Buffer = Buffer.alloc(0);
  consumed.bytes = start;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let from = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, from);
      if (nl < 0) break;
      const line = buf.subarray(from, nl);
      consumed.bytes += nl - from + 1;
      from = nl + 1;
      if (line.length === 0) continue;
      const text = line[line.length - 1] === 0x0d ? line.subarray(0, -1).toString("utf8") : line.toString("utf8");
      yield text;
    }
    carry = from < buf.length ? Buffer.from(buf.subarray(from)) : Buffer.alloc(0);
  }
  // whatever is left is a partial line without a newline; leave it for the next run
}
