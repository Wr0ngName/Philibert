/**
 * How a discussion is laid out on disk: two files, named by its id.
 *
 * - `<id>.json`, its details — everything but the messages: title, folder,
 *   dates, session, settings. Small, and replaced whole (durable-file).
 *   It is what says the discussion exists: the list reads these, a save
 *   writes it after the messages, and a messages file without one is not a
 *   discussion.
 * - `<id>.messages.jsonl`, its messages, appended to (conversation-log).
 *
 * Versions up to 0.25.13 kept everything in `<id>.json`; conversation-migration
 * converts those.
 */

import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import { summaryOf } from '../../shared/conversation-list';
import type { Conversation, ConversationSummary } from '../../shared/types';

import { parseRecord } from './conversation-log';

/** What is stored of a discussion besides its messages; `sessionGone` is worked out, never stored. */
export type ConversationDetails = Omit<Conversation, 'messages' | 'sessionGone'>;

export const DETAILS_SUFFIX = '.json';
const MESSAGES_SUFFIX = '.messages.jsonl';
/**
 * The saved index of a messages file (transcript-index). Not `.json`: every
 * `.json` in the folder is a discussion's details.
 */
const MESSAGES_INDEX_SUFFIX = '.messages.index';

/** Whether a name in the conversations folder is a discussion's details file. */
export function isDetailsFileName(name: string): boolean {
  return name.endsWith(DETAILS_SUFFIX);
}

/** The file a discussion's messages are kept in, beside its details file. */
export function messagesFileOf(detailsFile: string): string {
  return `${detailsFile.slice(0, -DETAILS_SUFFIX.length)}${MESSAGES_SUFFIX}`;
}

/** The saved index of a discussion's messages file, beside its details file. */
export function messagesIndexFileOf(detailsFile: string): string {
  return `${detailsFile.slice(0, -DETAILS_SUFFIX.length)}${MESSAGES_INDEX_SUFFIX}`;
}

/**
 * The details file a discussion's other file belongs to — its messages
 * file or their index — or null for a name that is neither.
 */
export function detailsFileNameOf(name: string): string | null {
  for (const suffix of [MESSAGES_SUFFIX, MESSAGES_INDEX_SUFFIX]) {
    if (name.endsWith(suffix)) return `${name.slice(0, -suffix.length)}${DETAILS_SUFFIX}`;
  }
  return null;
}

/** Whether parsed details are a whole discussion in the one-file format. */
export function isOneFileFormat(parsed: unknown): parsed is Conversation {
  return Array.isArray((parsed as { messages?: unknown }).messages);
}

/**
 * A discussion's details, its title the one it is listed under: the title
 * its first message gives unless it was renamed (summaryOf), so the list
 * can show it without reading the messages.
 */
export function detailsOf(conversation: Conversation): ConversationDetails {
  const details: ConversationDetails & { messages?: unknown } = {
    ...conversation,
    title: summaryOf(conversation).title,
  };
  delete details.messages;
  return details;
}

/**
 * Whether Claude has replied in a discussion: a message of Claude's is in its
 * messages file — or, for a one-file discussion not converted yet, among the
 * messages it holds. Read a piece at a time, up to the first reply, which is
 * near the start of any discussion that has one.
 *
 * What it is for: a discussion Claude replied in had a Claude Code session,
 * so one with no session id has lost it (Conversation.sessionGone) — it is
 * not one just started. A reply taken back since by a rewind still counts.
 */
export async function hasClaudeReply(
  detailsFile: string,
  stored: ConversationDetails & { messages?: unknown },
): Promise<boolean> {
  if (isOneFileFormat(stored)) return stored.messages.some((message) => message.role === 'assistant');
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(messagesFileOf(detailsFile), 'r');
  } catch (error) {
    // No messages file: nothing was said in it.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const isReply = (line: string) => {
    const record = parseRecord(line);
    return record !== null && 'put' in record && record.put.role === 'assistant';
  };
  try {
    // A piece at a time, split into lines: a line may end in the next piece,
    // and a character across two of them is put together by the decoder.
    const buffer = Buffer.alloc(REPLY_SCAN_CHUNK_BYTES);
    const decoder = new StringDecoder('utf8');
    let rest = '';
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const lines = (rest + decoder.write(buffer.subarray(0, bytesRead))).split('\n');
      rest = lines.pop()!;
      if (lines.some(isReply)) return true;
    }
    return isReply(rest + decoder.end());
  } finally {
    await handle.close();
  }
}

/** How much of a messages file hasClaudeReply reads at a time. */
const REPLY_SCAN_CHUNK_BYTES = 64 * 1024;

/**
 * The list entry of a parsed details file — or of a one-file discussion
 * copied into the folder and not converted yet, which has its messages.
 */
export function summaryOfStored(stored: ConversationDetails & { messages?: unknown }): ConversationSummary {
  return summaryOf({ ...stored, messages: isOneFileFormat(stored) ? stored.messages : [] });
}
