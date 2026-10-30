import type { ToolUseInfo } from '@shared/types';

/**
 * How long a background task — or a tool call — has been running, as text.
 *
 * `now` is passed in rather than read here, because a duration that reads the
 * clock itself cannot be reactive: `Date.now()` inside a Vue computed is not a
 * dependency, so the computed caches its first value and the figure never
 * moves again. That was the task detail modal — its runtime froze at whatever
 * it said when the modal opened. The caller supplies a ticking clock
 * (`useNowTicker`), which is a dependency.
 */
export interface TaskTiming {
  startedAt: number;
  /** Set once the task is no longer running. */
  completedAt?: number;
}

/**
 * A tool call's timing, or null when it has no duration worth showing: still
 * waiting for approval, rejected so it never ran, or finished without a
 * recorded end (saved before ends were recorded) — measured up to now, that
 * last would read as having run for days.
 *
 * `calledAt` is the call's message timestamp: when Claude made the call.
 */
export function toolCallTiming(
  toolUse: Pick<ToolUseInfo, 'status' | 'startedAt' | 'completedAt'>,
  calledAt: number,
): TaskTiming | null {
  const startedAt = toolUse.startedAt ?? calledAt;
  switch (toolUse.status) {
    case 'approved': return { startedAt };
    case 'executed':
    case 'failed':
      return toolUse.completedAt === undefined ? null : { startedAt, completedAt: toolUse.completedAt };
    default: return null;
  }
}

/** Elapsed milliseconds, up to completion or up to `now`. */
export function taskElapsedMs(task: TaskTiming, now: number): number {
  const endTime = task.completedAt ?? now;
  // Never negative: a task created from a notification carries the sender's
  // clock, and a few milliseconds of skew would otherwise render as "-1s".
  return Math.max(0, endTime - task.startedAt);
}

/**
 * `45s`, `3m 07s`, `2h 14m`.
 *
 * Hours matter: a task the app failed to notice had ended used to sit in the
 * panel reading "1620m 12s".
 */
export function formatTaskDuration(task: TaskTiming, now: number): string {
  const seconds = Math.floor(taskElapsedMs(task, now) / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}
