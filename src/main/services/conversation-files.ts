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

import { summaryOf } from '../../shared/conversation-list';
import type { Conversation, ConversationSummary } from '../../shared/types';

export type ConversationDetails = Omit<Conversation, 'messages'>;

export const DETAILS_SUFFIX = '.json';
const MESSAGES_SUFFIX = '.messages.jsonl';

/** Whether a name in the conversations folder is a discussion's details file. */
export function isDetailsFileName(name: string): boolean {
  return name.endsWith(DETAILS_SUFFIX);
}

/** Whether a name in the conversations folder is a discussion's messages file. */
export function isMessagesFileName(name: string): boolean {
  return name.endsWith(MESSAGES_SUFFIX);
}

/** The file a discussion's messages are kept in, beside its details file. */
export function messagesFileOf(detailsFile: string): string {
  return `${detailsFile.slice(0, -DETAILS_SUFFIX.length)}${MESSAGES_SUFFIX}`;
}

/** The details file a messages file belongs to. */
export function detailsFileNameOf(messagesFile: string): string {
  return `${messagesFile.slice(0, -MESSAGES_SUFFIX.length)}${DETAILS_SUFFIX}`;
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
 * The list entry of a parsed details file — or of a one-file discussion
 * copied into the folder and not converted yet, which has its messages.
 */
export function summaryOfStored(stored: ConversationDetails & { messages?: unknown }): ConversationSummary {
  return summaryOf({ ...stored, messages: isOneFileFormat(stored) ? stored.messages : [] });
}
