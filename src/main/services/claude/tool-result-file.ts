/**
 * Where a tool call's result is kept for the detail view.
 *
 * Results are written to a file rather than sent to the renderer: they can be
 * megabytes, and the detail modal only needs one when it is opened. The live
 * stream and agent transcripts read back both write here, under the same name
 * for the same call, so a call's detail reads the same wherever it is opened.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The directory results are written to. Readable by `files:read`. */
export function toolResultsDir(): string {
  return path.join(os.tmpdir(), 'claude', 'tool-results');
}

/** Write a call's result and return the file it is in. */
export function writeToolResultFile(conversationId: string, toolUseBlockId: string, content: string): string {
  const dir = toolResultsDir();
  fs.mkdirSync(dir, { recursive: true });
  const safeId = toolUseBlockId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = path.join(dir, `${conversationId}_${safeId}.txt`);
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}
