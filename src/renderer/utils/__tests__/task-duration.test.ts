/**
 * The elapsed time a background task shows.
 *
 * Reported as the runtime timer sometimes stopping. Three things froze it,
 * and this file covers the two that live in the formatting: a duration
 * measured to a clock the caller supplies (so it can be reactive), and one
 * measured to `completedAt` only once the task has actually finished.
 */

import { describe, it, expect } from 'vitest';

import { formatTaskDuration, taskElapsedMs, toolCallTiming } from '../task-duration';

const START = 1_700_000_000_000;

describe('formatTaskDuration', () => {
  it('counts up as the clock the caller passes moves', () => {
    // The whole point of taking `now` as an argument. Reading the clock
    // inside the function is what made the modal's computed cache one value
    // for as long as it was open.
    expect(formatTaskDuration({ startedAt: START }, START + 3_000)).toBe('3s');
    expect(formatTaskDuration({ startedAt: START }, START + 4_000)).toBe('4s');
  });

  it('stops at completion, whatever the clock says afterwards', () => {
    const task = { startedAt: START, completedAt: START + 12_000 };
    expect(formatTaskDuration(task, START + 12_000)).toBe('12s');
    expect(formatTaskDuration(task, START + 900_000)).toBe('12s');
  });

  it('shows seconds under a minute', () => {
    expect(formatTaskDuration({ startedAt: START }, START)).toBe('0s');
    expect(formatTaskDuration({ startedAt: START }, START + 59_999)).toBe('59s');
  });

  it('shows minutes and seconds under an hour', () => {
    expect(formatTaskDuration({ startedAt: START }, START + 60_000)).toBe('1m 00s');
    expect(formatTaskDuration({ startedAt: START }, START + 187_000)).toBe('3m 07s');
    expect(formatTaskDuration({ startedAt: START }, START + 3_599_000)).toBe('59m 59s');
  });

  it('shows hours rather than a four-digit minute count', () => {
    // A task the app failed to notice had ended read "1620m 12s".
    expect(formatTaskDuration({ startedAt: START }, START + 3_600_000)).toBe('1h 00m');
    expect(formatTaskDuration({ startedAt: START }, START + 8_040_000)).toBe('2h 14m');
    expect(formatTaskDuration({ startedAt: START }, START + 97_212_000)).toBe('27h 00m');
  });

  it('never renders a negative duration', () => {
    // A task created from a notification carries the sender's clock.
    expect(formatTaskDuration({ startedAt: START + 500 }, START)).toBe('0s');
    expect(taskElapsedMs({ startedAt: START + 500 }, START)).toBe(0);
  });
});

describe('toolCallTiming', () => {
  it('runs from when Claude made the call, for one that needed no approval', () => {
    expect(toolCallTiming({ status: 'approved' }, START)).toEqual({ startedAt: START });
  });

  it('runs from the approval, not the wait for it', () => {
    expect(toolCallTiming({ status: 'approved', startedAt: START + 30_000 }, START))
      .toEqual({ startedAt: START + 30_000 });
  });

  it('ends where the call finished, failed or not', () => {
    expect(toolCallTiming({ status: 'executed', completedAt: START + 12_000 }, START))
      .toEqual({ startedAt: START, completedAt: START + 12_000 });
    expect(toolCallTiming({ status: 'failed', completedAt: START + 3_000 }, START))
      .toEqual({ startedAt: START, completedAt: START + 3_000 });
  });

  it('has none for a call that never ran, or whose end was never recorded', () => {
    expect(toolCallTiming({ status: 'pending' }, START)).toBeNull();
    expect(toolCallTiming({ status: 'rejected' }, START)).toBeNull();
    // Saved before ends were recorded: measured to now it would read as days.
    expect(toolCallTiming({ status: 'executed' }, START)).toBeNull();
  });
});
