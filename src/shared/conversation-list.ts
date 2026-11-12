/**
 * The rules of the discussions list, shared by the main process, which pages
 * it, and the renderer, which keeps the pages it holds up to date.
 *
 * Archived is worked out rather than stored as a state, so that nothing has to
 * sweep the discussions to archive the inactive ones, the setting applies at
 * once both ways, and coming back to a discussion needs no write:
 *
 * - archived by hand: `archivedAt` is set and nothing has happened in the
 *   discussion since — a message after it, a background task reporting say,
 *   brings it back by itself (the user cannot write in an archived one: it
 *   is brought back first);
 * - otherwise, archived when its last activity is older than the setting's
 *   days. Activity is its last message, being brought back from the archive,
 *   and a usage limit's wait on record (`usageLimitWait`, see waitActivity):
 *   the task it stopped is to go on, so the days count from when it is to.
 *   A continue as far out as the archive delay comes before archiving, and
 *   one missed while the app was closed leaves the user the archive delay to
 *   pick it up from the list — and no longer: a wait only moves the point
 *   the days count from, it never stops them;
 * - and archived for good, whatever the above, once the Claude Code session
 *   it continues is gone (`sessionGone`): there is nothing left to continue,
 *   and writing in it would start over with a Claude that remembers none of
 *   it.
 */

import { titleFromMessages } from './conversation-title';
import type { AutoArchiveDays, Conversation, ConversationListCursor, ConversationSummary, UsageLimitWait } from './types';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** What the user is told when a prompt finds the discussion's Claude Code session gone. */
export const SESSION_GONE_NOTICE =
  "Claude's session for this discussion no longer exists — Claude Code deleted it — " +
  'so the discussion was moved to the archive. Its history is kept.';

type ArchiveFields = Pick<ConversationSummary, 'updatedAt' | 'archivedAt' | 'restoredAt' | 'sessionGone' | 'usageLimitWait'>;

export function isArchived(conversation: ArchiveFields, autoArchiveDays: AutoArchiveDays, now: number): boolean {
  if (conversation.sessionGone) return true;
  if (conversation.archivedAt !== undefined) return conversation.archivedAt >= conversation.updatedAt;
  if (autoArchiveDays === 0) return false;
  const lastActivity = Math.max(
    conversation.updatedAt,
    conversation.restoredAt ?? 0,
    waitActivity(conversation.usageLimitWait),
  );
  return lastActivity < now - autoArchiveDays * DAY_MS;
}

/**
 * When a usage limit's wait counts as activity: when the user was told its
 * continue was missed; else when it is to continue; else, nothing being
 * scheduled, when the limit resets and the user can continue it. A time
 * that is set once, so archiving is put back, never put off for good.
 */
export function waitActivity(wait: UsageLimitWait | undefined): number {
  if (!wait) return 0;
  return wait.missedAt ?? wait.resumeAt ?? wait.resetsAt;
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
    ...(conversation.usageLimitWait !== undefined ? { usageLimitWait: conversation.usageLimitWait } : {}),
  };
}
