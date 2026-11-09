/**
 * Writing files so that stopping part-way never leaves a damaged one.
 *
 * `fs.promises.writeFile` over an existing file empties it first and then
 * writes it in pieces: a process ended in between leaves only its start. On
 * 2026-11-09 a discussion of 68,144 messages was cut to its first 3.5 MiB
 * that way, when the app quit one second into rewriting it.
 *
 * - `replaceFile` writes beside the file, flushes it to disk, and renames it
 *   over the old one. A rename within a folder is atomic: a reader, or the
 *   next start, sees the old file or the new one, never a mix.
 * - `appendToFile` adds to the end and flushes. Ended part-way, it leaves the
 *   file as it was plus an unfinished last piece, which a reader of an
 *   append-only file skips (see conversation-log).
 */

import fs from 'node:fs';

/**
 * Errors a rename on Windows gives while another program holds the file open
 * for a moment — an antivirus or the search indexer reading what was just
 * written. Gone a few milliseconds later.
 */
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_DELAY_MS = 50;

/** The temporary file `replaceFile` writes beside `file`. */
export function temporaryFileOf(file: string): string {
  return `${file}.tmp`;
}

/** Whether a file name is one `replaceFile` left behind, stopped before its rename. */
export function isTemporaryFile(name: string): boolean {
  return name.endsWith('.tmp');
}

/** Replace a file's content in one step; see the top of this file. */
export function replaceFile(file: string, content: string): Promise<void> {
  return replaceFileWith(file, (handle) => handle.writeFile(content, 'utf-8'));
}

/**
 * Replace a file in one step with what `write` writes to the new one — in
 * as many pieces as it likes, so content larger than memory can be written.
 * Should `write` throw, the file is left as it was.
 */
export async function replaceFileWith(
  file: string,
  write: (handle: fs.promises.FileHandle) => Promise<void>,
): Promise<void> {
  const temporary = temporaryFileOf(file);
  const handle = await fs.promises.open(temporary, 'w');
  try {
    await write(handle);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.promises.unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();

  for (let attempt = 1; ; attempt++) {
    try {
      await fs.promises.rename(temporary, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !BUSY_CODES.has(code) || attempt >= RENAME_ATTEMPTS) {
        await fs.promises.unlink(temporary).catch(() => undefined);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAY_MS * attempt));
    }
  }
}

/** Add to the end of a file, creating it if needed, and flush it to disk. */
export async function appendToFile(file: string, content: string): Promise<void> {
  const handle = await fs.promises.open(file, 'a');
  try {
    await handle.appendFile(content, 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}
