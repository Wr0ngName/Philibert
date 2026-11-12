/**
 * What this app keeps of a discussion outside the discussion's own files, and
 * removing it when the discussion is deleted: the call results written for
 * the detail view.
 *
 * What Claude Code keeps of the discussion's session — its transcript, its
 * agents', its task list, file history and task outputs — is left to Claude
 * Code: its own clean-up deletes them once older than `cleanupPeriodDays`
 * (https://code.claude.com/docs/en/claude-directory#cleaned-up-automatically),
 * the retention the settings expose. Removing a part of them from here was
 * misleading: the rest stayed regardless, until that clean-up.
 */

import fs from 'node:fs';
import path from 'node:path';

import { toolResultsDir } from './tool-result-file';

/**
 * Remove the call results written for a discussion's detail view
 * (writeToolResultFile names them `<conversationId>_<call id>.txt`).
 *
 * @returns how many were removed.
 */
export async function deleteToolResults(conversationId: string): Promise<number> {
  const dir = toolResultsDir();
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  // A conversation id is `conv_<time>_<random>` (generateId): none is
  // another's followed by an underscore, so the prefix is this one's alone.
  const prefix = `${conversationId}_`;
  const mine = names.filter((name) => name.startsWith(prefix));
  for (const name of mine) {
    await fs.promises.unlink(path.join(dir, name));
  }
  return mine.length;
}
