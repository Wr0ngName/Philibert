/**
 * Converting discussions stored in one file (versions up to 0.25.13) to a
 * details file and an append-only messages file (conversation-files).
 *
 * Run over the whole folder at startup, before anything reads it, and on
 * any one-file discussion met later — one copied into the folder while the
 * app runs — so the rest of the app only ever reads the new layout.
 *
 * Safe to stop at any point. The messages file is written first, then the
 * details file replaces the one-file discussion; both are replaced in one
 * step (durable-file). Stopped before the second, the discussion is still in
 * one file, and the next start converts it again from it.
 *
 * Two repairs older versions needed on reading are made here, once:
 * repeated message ids, and task rows not yet folded into their calls.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { BackgroundTaskInfo, ChatMessage, Conversation, ToolUseInfo } from '../../shared/types';
import { isTemporaryFile, replaceFile } from '../utils/durable-file';
import logger from '../utils/logger';

import {
  type ConversationDetails, detailsFileNameOf, detailsOf, isDetailsFileName, isOneFileFormat,
  messagesFileOf, messagesIndexFileOf,
} from './conversation-files';
import { compactedLog } from './conversation-log';
import { writeTranscriptIndex } from './transcript-index';

/**
 * A stored transcript with any repeated message id dropped, keeping the first.
 *
 * A message id is the identity of a row everywhere above here: it keys the
 * upsert that writes it, the height the virtual list measures it at, and the
 * anchor a page of history is fetched against. Two messages sharing one makes
 * all three ambiguous — the same message shown twice, measured as two rows,
 * and written twice on the next save.
 *
 * Nothing this app does produces a duplicate: an upsert is keyed by id, so a
 * repeat replaces rather than appends — and the messages file replays the
 * same way. A one-file discussion can still arrive with one — a hand edit, a
 * restore from a partial copy, a version of this app that had a bug — and
 * that should cost the user a dropped duplicate, not a transcript that
 * cannot be paged through.
 */
export function withoutRepeatedIds(id: string, messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  const kept: ChatMessage[] = [];
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    kept.push(message);
  }

  if (kept.length !== messages.length) {
    logger.warn('Dropped repeated message ids from a stored conversation', {
      id, stored: messages.length, kept: kept.length,
    });
  }
  return kept;
}

/** A call as 0.25.1-rc.2 and rc.3 stored it: an Agent call's record was `agentTask`. */
type StoredToolUse = ToolUseInfo & { agentTask?: BackgroundTaskInfo };

/**
 * A stored transcript with each task row folded into the call that started
 * the task, so the task has one row: its call (see ToolUseInfo.task). Two
 * things older versions wrote:
 *
 * - A background command drawn twice — its call, and a task row of its own,
 *   because the first notice of the task did not name the call. The row's
 *   record moves onto the call and the row goes. Matched by id only: the
 *   row's task id (the call's block id, which that first notice used as the
 *   task's id) or its tool_use id. A row matching no call here is a task with
 *   no call in the transcript, and stays.
 * - An Agent call's record under `agentTask` (rc.2, rc.3), read as `task`.
 */
export function withTaskRowsOnCalls(id: string, messages: ChatMessage[]): ChatMessage[] {
  let renamed = 0;
  const named = messages.map((message) => {
    const toolUse = message.toolUse as StoredToolUse | undefined;
    if (!toolUse?.agentTask) return message;
    renamed++;
    const { agentTask, ...rest } = toolUse;
    return { ...message, toolUse: { ...rest, task: rest.task ?? agentTask } };
  });

  const callIds = new Set(
    named.flatMap((message) => (message.toolUse?.toolUseBlockId ? [message.toolUse.toolUseBlockId] : [])),
  );
  const rowsByCall = new Map<string, BackgroundTaskInfo>();
  const kept = named.filter((message) => {
    const row = message.backgroundTask;
    if (!row) return true;
    const callId = [row.taskId, row.toolUseId].find((candidate) => candidate !== undefined && callIds.has(candidate));
    if (callId === undefined) return true;
    rowsByCall.set(callId, row);
    return false;
  });

  if (renamed === 0 && rowsByCall.size === 0) return messages;
  logger.info('Folded task rows of a stored conversation into their calls', {
    id, folded: rowsByCall.size, renamed,
  });
  return kept.map((message) => {
    const toolUse = message.toolUse;
    const row = toolUse?.toolUseBlockId ? rowsByCall.get(toolUse.toolUseBlockId) : undefined;
    // A call that already has a record keeps it: the row was a second copy.
    return toolUse && row && !toolUse.task ? { ...message, toolUse: { ...toolUse, task: row } } : message;
  });
}

/**
 * Convert one one-file discussion, already read; see the top of this file.
 *
 * @returns the details now stored.
 */
export async function convertOneFileDiscussion(detailsFile: string, stored: Conversation): Promise<ConversationDetails> {
  const messages = withTaskRowsOnCalls(stored.id, withoutRepeatedIds(stored.id, stored.messages));
  const details = detailsOf({ ...stored, messages });
  const log = compactedLog(messages);
  await replaceFile(messagesFileOf(detailsFile), log.text);
  await replaceFile(detailsFile, JSON.stringify(details, null, 2));
  // Its index, so the first opening does not read the file whole again.
  await writeTranscriptIndex(messagesFileOf(detailsFile), messagesIndexFileOf(detailsFile), log.state);
  logger.info('Converted a discussion to the appended format', {
    id: stored.id, messages: messages.length,
  });
  return details;
}

export interface FolderConversion {
  converted: number;
  /** Files that could not be read: left exactly as they are. */
  unreadable: string[];
  /** Temporary files of writes stopped before their rename, removed. */
  temporaryRemoved: number;
  /**
   * Messages files and their indexes with no details file, removed. A
   * discussion's details file is written after its messages and removed
   * before them, so one without is the start of a first save, or the rest
   * of a deletion, that was stopped: not a discussion the user ever saw
   * listed.
   */
  leftoversRemoved: number;
}

/** Where a conversion of the folder has got to: about to convert the discussion `at` of `of` checked. */
export interface ConversionProgress {
  at: number;
  of: number;
}

/**
 * Convert every one-file discussion in the folder; see the top of this file.
 *
 * `onConverting` is told before each conversion, which can take seconds for
 * a long discussion, so startup can say why it is waiting.
 */
export async function convertConversationFolder(
  dir: string,
  onConverting: (progress: ConversionProgress) => void = () => {},
): Promise<FolderConversion> {
  const result: FolderConversion = { converted: 0, unreadable: [], temporaryRemoved: 0, leftoversRemoved: 0 };
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error;
  }

  const detailsFiles = names.filter(isDetailsFileName);
  for (const name of names) {
    const file = path.join(dir, name);
    if (isTemporaryFile(name)) {
      // The file it was to replace is still whole: nothing in it is lost.
      await fs.promises.unlink(file);
      result.temporaryRemoved += 1;
      continue;
    }
    if (!isDetailsFileName(name)) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.promises.readFile(file, 'utf-8'));
    } catch (error) {
      // Kept as it is, for whatever can still be recovered from it.
      logger.warn('Left an unreadable discussion file as it is', { file: name, error });
      result.unreadable.push(name);
      continue;
    }
    if (!isOneFileFormat(parsed)) continue;
    onConverting({ at: detailsFiles.indexOf(name) + 1, of: detailsFiles.length });
    try {
      await convertOneFileDiscussion(file, parsed);
      result.converted += 1;
    } catch (error) {
      // Still whole in its one file; converted when it is next opened.
      logger.error('Failed to convert a discussion to the appended format', { file: name, error });
    }
  }

  const present = new Set(names);
  for (const name of names) {
    const details = detailsFileNameOf(name);
    if (details === null || present.has(details)) continue;
    await fs.promises.unlink(path.join(dir, name));
    result.leftoversRemoved += 1;
  }

  if (result.converted > 0 || result.unreadable.length > 0 || result.temporaryRemoved > 0 || result.leftoversRemoved > 0) {
    logger.info('Conversation folder checked for the appended format', {
      converted: result.converted,
      unreadable: result.unreadable.length,
      temporaryRemoved: result.temporaryRemoved,
      leftoversRemoved: result.leftoversRemoved,
    });
  }
  return result;
}
