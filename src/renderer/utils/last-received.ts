/**
 * The line under a discussion saying when Claude was last heard from, as
 * Claude Code ends a turn with when it was done — with, while some are still
 * going, how many background tasks may yet report back.
 */

import type { ChatMessage } from '@shared/types';

import { formatMoment } from './date';

export function lastReceivedLine(at: number, now: number, runningTasks: number): string {
  const parts = [`Last received ${formatMoment(at, now)}`];
  if (runningTasks > 0) {
    parts.push(`${runningTasks} background ${runningTasks === 1 ? 'task' : 'tasks'} still running`);
  }
  return parts.join(' · ');
}

/**
 * When something last arrived from an agent, by its transcript: what it said,
 * the calls it made, and their results coming back. Not what it was sent —
 * its prompt and the messages written to it are the user's side. Null when
 * nothing has arrived, or no time is known.
 */
export function lastReceivedInTranscript(messages: readonly ChatMessage[]): number | null {
  let last = 0;
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    last = Math.max(last, message.timestamp, message.toolUse?.completedAt ?? 0);
  }
  return last > 0 ? last : null;
}
