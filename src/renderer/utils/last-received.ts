/**
 * The line under a discussion saying when Claude was last heard from, as
 * Claude Code ends a turn with when it was done — with, while some are still
 * going, how many background tasks may yet report back.
 */

import { formatMoment } from './date';

export function lastReceivedLine(at: number, now: number, runningTasks: number): string {
  const parts = [`Last received ${formatMoment(at, now)}`];
  if (runningTasks > 0) {
    parts.push(`${runningTasks} background ${runningTasks === 1 ? 'task' : 'tasks'} still running`);
  }
  return parts.join(' · ');
}
