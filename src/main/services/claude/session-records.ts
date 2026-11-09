/**
 * What Claude Code keeps of a discussion outside this app's own files, and
 * removing it when the discussion is deleted.
 *
 * Deleting a discussion removed only this app's files: the session's
 * transcript and its agents' transcripts (`<config>/projects/…`), the task
 * output files under the CLI's temp root, and the call results this app
 * writes for the detail view stayed — until Claude Code's own clean-up of
 * sessions inactive for 30 days (its `cleanupPeriodDays`), or for ever for
 * the call results.
 */

import fs from 'node:fs';
import path from 'node:path';

import { deleteSession } from '@anthropic-ai/claude-agent-sdk';

import logger from '../../utils/logger';

import { cliTempRoot, sessionTempDirs } from './task-output';
import { toolResultsDir } from './tool-result-file';
import { findSessionTranscript } from './transcript-files';

/**
 * Remove a session's transcript, its agents' transcripts and its task
 * outputs. Only for a session no remaining discussion uses.
 *
 * @returns what was removed.
 */
export async function deleteSessionRecords(sessionId: string): Promise<{ transcript: boolean; tempDirs: number }> {
  // Looked for first: the SDK throws for a session it cannot find — one
  // Claude Code already cleaned up — and its message is not ours to read.
  const transcript = findSessionTranscript(sessionId) !== null;
  if (transcript) {
    // The transcript and the folder of its agents' transcripts.
    await deleteSession(sessionId);
  }

  const dirs = await sessionTempDirs(cliTempRoot(), sessionId);
  for (const dir of dirs) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }

  logger.info('Deleted the Claude Code records of a session', { sessionId, transcript, tempDirs: dirs.length });
  return { transcript, tempDirs: dirs.length };
}

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
