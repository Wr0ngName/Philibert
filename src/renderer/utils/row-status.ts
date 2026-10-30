/**
 * How a row in the discussion shows where it stands: its label, its colour,
 * and the mark beside it.
 *
 * One table for both kinds of row — a tool call, and a task — so that a call
 * standing for its task (an agent, a background command) reads exactly as the
 * task's own row would.
 */

import type { BackgroundTaskStatus, ToolUseInfo } from '@shared/types';

export type RowStatus = ToolUseInfo['status'] | BackgroundTaskStatus;

export interface RowStatusDisplay {
  label: string;
  colorClass: string;
  mark: 'spinner' | 'check' | 'error' | null;
}

const BLUE = 'text-blue-500 dark:text-blue-400';
const GREEN = 'text-green-500 dark:text-green-400';
const RED = 'text-red-500 dark:text-red-400';
const YELLOW = 'text-yellow-500 dark:text-yellow-400';

const DISPLAYS: Record<RowStatus, RowStatusDisplay> = {
  pending: { label: 'Pending', colorClass: YELLOW, mark: 'spinner' },
  approved: { label: 'Approved', colorClass: BLUE, mark: 'spinner' },
  running: { label: 'Running', colorClass: BLUE, mark: 'spinner' },
  executed: { label: 'Done', colorClass: GREEN, mark: 'check' },
  completed: { label: 'Done', colorClass: GREEN, mark: 'check' },
  rejected: { label: 'Rejected', colorClass: RED, mark: 'error' },
  failed: { label: 'Failed', colorClass: RED, mark: 'error' },
  stopped: { label: 'Stopped', colorClass: YELLOW, mark: 'error' },
};

/** A status read from a stored conversation may be one this version does not know: shown as nothing. */
const UNKNOWN: RowStatusDisplay = { label: '', colorClass: '', mark: null };

export function rowStatusDisplay(status: RowStatus): RowStatusDisplay {
  return DISPLAYS[status] ?? UNKNOWN;
}
