/**
 * A messages file's index (TranscriptState) saved beside it.
 *
 * Which messages a messages file holds, in what order, and where each one's
 * current line is, can only be learnt by reading it from the start: lines
 * are replaced further on, and a rewind cuts. Kept in memory only, that read
 * came back in every session — 1.4 s on a discussion of 69,144 messages,
 * before its first page could show. Saved, a later session reads the index
 * and the page's own lines.
 *
 * Only ever trusted for the file it was made from: it records that file's
 * size and modification time, and one that does not match them — a save
 * since, a crash before the index was written again, a file changed by
 * hand — is ignored, and the file read whole as before. An index can make a
 * read slower, never wrong.
 */

import fs from 'node:fs';

import { replaceFile } from '../utils/durable-file';

import { type SavedTranscriptState, TranscriptState } from './conversation-log';

/** Bumped when what is saved changes, so an older index is ignored. */
const INDEX_VERSION = 1;

interface SavedIndex {
  version: number;
  /** The messages file as it was when this was saved. */
  bytes: number;
  mtimeMs: number;
  state: SavedTranscriptState;
}

/**
 * Save a state as the index of its messages file, which must be as the
 * state describes it — written by the same writes, none since.
 */
export async function writeTranscriptIndex(messagesFile: string, indexFile: string, state: TranscriptState): Promise<void> {
  const stat = await fs.promises.stat(messagesFile);
  const saved: SavedIndex = { version: INDEX_VERSION, bytes: stat.size, mtimeMs: stat.mtimeMs, state: state.save() };
  await replaceFile(indexFile, JSON.stringify(saved));
}

/**
 * The state an index saved for this messages file, or null when there is
 * none, or it does not match the file as it now is.
 */
export async function readTranscriptIndex(messagesFile: string, indexFile: string): Promise<TranscriptState | null> {
  let saved: Partial<SavedIndex>;
  let stat: fs.Stats;
  try {
    saved = JSON.parse(await fs.promises.readFile(indexFile, 'utf-8')) as Partial<SavedIndex>;
    stat = await fs.promises.stat(messagesFile);
  } catch {
    return null;
  }
  if (saved.version !== INDEX_VERSION || saved.bytes !== stat.size || saved.mtimeMs !== stat.mtimeMs) return null;
  return TranscriptState.restore(saved.state);
}
