/**
 * The title a discussion is listed under until it is renamed: its first
 * message, on one line.
 *
 * It is not cut to a number of characters for the list: the list cuts it
 * where its row ends, at whatever width the list is set to. Titles used to
 * be cut at 50 characters when made, so a list made wider still showed them
 * cut at 50.
 *
 * It is kept no longer than the widest list can show (SIDEBAR_WIDTH.MAX),
 * so a pasted log does not travel into every list entry. Measured in the app
 * (2026-11-05): at 600px the title has 536px, and its narrowest letter, "i",
 * is 3.61px wide — 148 of them fit; 200 overflow, so the bound is never seen.
 */

import type { ChatMessage } from './types';

/** Longest title kept: more than the widest list shows, in any letters. */
export const TITLE_STORED_LENGTH = 200;

/** The title a discussion's messages give it; none before its first message. */
export function titleFromMessages(messages: readonly Pick<ChatMessage, 'role' | 'content'>[]): string | undefined {
  const first = messages.find((message) => message.role === 'user');
  if (!first || typeof first.content !== 'string') return undefined;
  const line = first.content.replace(/\s+/g, ' ').trim();
  if (!line) return undefined;
  return line.length <= TITLE_STORED_LENGTH ? line : `${line.slice(0, TITLE_STORED_LENGTH - 1)}…`;
}
