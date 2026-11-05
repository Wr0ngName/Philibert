/**
 * The rules of the discussions list, shared by the main process, which pages
 * it, and the renderer, which keeps the pages it holds up to date.
 *
 * Archived is worked out rather than stored as a state, so that nothing has to
 * sweep the discussions to archive the inactive ones, the setting applies at
 * once both ways, and coming back to a discussion needs no write:
 *
 * - archived by hand: `archivedAt` is set and nothing has happened in the
 *   discussion since — a message after it brings it back by itself;
 * - otherwise, archived when its last activity — its last message, or being
 *   brought back from the archive — is older than the setting's days.
 */

import { titleFromMessages } from './conversation-title';
import type { AutoArchiveDays, Conversation, ConversationListCursor, ConversationSummary } from './types';

export const DAY_MS = 24 * 60 * 60 * 1000;

type ArchiveFields = Pick<ConversationSummary, 'updatedAt' | 'archivedAt' | 'restoredAt'>;

export function isArchived(conversation: ArchiveFields, autoArchiveDays: AutoArchiveDays, now: number): boolean {
  if (conversation.archivedAt !== undefined) return conversation.archivedAt >= conversation.updatedAt;
  if (autoArchiveDays === 0) return false;
  const lastActivity = Math.max(conversation.updatedAt, conversation.restoredAt ?? 0);
  return lastActivity < now - autoArchiveDays * DAY_MS;
}

/** Newest first; the id settles a tie, so the order — and a cursor in it — is total. */
export function newestFirst(a: ConversationListCursor, b: ConversationListCursor): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Whether an entry comes after the cursor in newest-first order. */
export function isAfter(entry: ConversationListCursor, cursor: ConversationListCursor): boolean {
  return newestFirst(entry, cursor) > 0;
}

/**
 * The list entry of a conversation: what ConversationSummary keeps of it.
 * Its title is the one its first message gives it, unless it was renamed —
 * so a title saved cut short, as titles once were, is listed whole.
 */
export function summaryOf(conversation: Conversation): ConversationSummary {
  return {
    id: conversation.id,
    title: (!conversation.customTitle && titleFromMessages(conversation.messages)) || conversation.title,
    workingDirectory: conversation.workingDirectory,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    ...(conversation.customTitle !== undefined ? { customTitle: conversation.customTitle } : {}),
    ...(conversation.executionMode !== undefined ? { executionMode: conversation.executionMode } : {}),
    ...(conversation.archivedAt !== undefined ? { archivedAt: conversation.archivedAt } : {}),
    ...(conversation.restoredAt !== undefined ? { restoredAt: conversation.restoredAt } : {}),
  };
}
