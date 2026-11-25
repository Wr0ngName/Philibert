/**
 * Where a session resumes when the conversation is rewound to a prompt.
 *
 * `resumeSessionAt` keeps the transcript "up to and including" the entry it
 * names. Given the prompt rewound to, the CLI keeps that prompt — only its
 * answer goes — and the next message joins it as the same user turn:
 * measured (CLI 2.1.280), after a rewind to "two" of one/two/three, the next
 * request was `one`, `reply 1`, then `two` and the new message together. So
 * Claude went on with the prompt the user had rewound away from.
 *
 * The session resumes instead at the entry before the prompt — the last of
 * the turn kept, as the SDK's guidance on fork points says — which is the
 * prompt's `parentUuid` in the transcript: measured, the next request was
 * then `one`, `reply 1` and the new message alone.
 *
 * `resumeDropsTurn`, the SDK's check that the resume drops one turn and
 * nothing else, is not used: a rewind drops every turn after the point, and
 * the CLI refuses the resume as soon as there are two (measured).
 *
 * Read from the transcript's own records, their `uuid` and `parentUuid`
 * fields: the SDK reads the chain from them too (getSessionMessages), but
 * gives neither back. Streamed, and only the line naming the prompt is
 * parsed: a long discussion's transcript runs to hundreds of megabytes.
 */

import fs from 'node:fs';
import readline from 'node:readline';

/**
 * Where to resume to drop `promptUuid` and everything after it: the entry
 * before it, or null for the first prompt — nothing is kept, and the next
 * message starts a session of its own. Undefined when the transcript has no
 * such prompt, or cannot be read.
 */
export async function resumePointBefore(transcriptFile: string, promptUuid: string): Promise<string | null | undefined> {
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(transcriptFile, { encoding: 'utf8' });
  } catch {
    return undefined;
  }
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes(promptUuid)) continue;
      let entry: { type?: unknown; uuid?: unknown; parentUuid?: unknown };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue;
      }
      if (entry.uuid !== promptUuid || entry.type !== 'user') continue;
      return typeof entry.parentUuid === 'string' ? entry.parentUuid : null;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    lines.close();
    stream.destroy();
  }
}
