/**
 * Reading only some byte ranges of a file.
 *
 * A page of a long discussion is a few hundred lines of a messages file that
 * can be tens of megabytes (conversation-log): reading those lines rather
 * than the file is what keeps a page fast whatever the discussion's length.
 */

import fs from 'node:fs';

export interface ByteRange {
  start: number;
  length: number;
}

/**
 * Ranges this close are read as one: a page's lines are mostly next to each
 * other, and one read of a little more costs less than many small ones.
 */
const MERGE_GAP_BYTES = 64 * 1024;

/** The bytes of each range, in the order given. */
export async function readRanges(file: string, ranges: readonly ByteRange[]): Promise<Buffer[]> {
  if (ranges.length === 0) return [];
  const order = ranges.map((_, i) => i).sort((a, b) => ranges[a].start - ranges[b].start);

  // Runs of ranges read together.
  const runs: Array<{ start: number; end: number; members: number[] }> = [];
  for (const i of order) {
    const { start, length } = ranges[i];
    const last = runs.at(-1);
    if (last && start <= last.end + MERGE_GAP_BYTES) {
      last.end = Math.max(last.end, start + length);
      last.members.push(i);
    } else {
      runs.push({ start, end: start + length, members: [i] });
    }
  }

  const out: Buffer[] = new Array(ranges.length);
  const handle = await fs.promises.open(file, 'r');
  try {
    for (const run of runs) {
      const buffer = Buffer.alloc(run.end - run.start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, run.start);
      if (bytesRead < buffer.length) {
        throw new Error(`${file} ends at byte ${run.start + bytesRead}, before ${run.end}`);
      }
      for (const i of run.members) {
        const offset = ranges[i].start - run.start;
        out[i] = buffer.subarray(offset, offset + ranges[i].length);
      }
    }
  } finally {
    await handle.close();
  }
  return out;
}
