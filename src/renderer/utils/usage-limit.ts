/**
 * Waiting out a claude.ai usage limit, the way interactive Claude Code does.
 *
 * In a terminal, a turn stopped by a usage limit shows "Usage limit reached ·
 * continuing automatically at 7:50pm · esc to cancel" and carries on once the
 * limit resets. That wait only exists in the CLI's interactive mode: an SDK
 * session like ours just ends the turn, so the waiting happens here. The
 * timing and the prompt are the CLI's own.
 *
 * Kept as pure functions, apart from the store and the composable that act on
 * them, because this is the part with rules in it.
 */

import type { UsageLimitStop } from '@shared/types';

/** What the CLI sends when it continues a task after the limit resets. */
export const USAGE_LIMIT_CONTINUE_PROMPT =
  'Your claude.ai usage limit has reset. Continue the task you were working on when the limit ' +
  'was reached; do not repeat work that is already complete.';

/** How far ahead a reset may be and still be waited for — the CLI's own cap. */
export const MAX_USAGE_LIMIT_WAIT_MS = 24 * 60 * 60 * 1000;

/**
 * How long after the reset to continue. The CLI waits between 30 and 90
 * seconds past it, so that every session waiting on the same reset does not
 * fire at the same instant.
 */
const RESUME_DELAY_MIN_MS = 30_000;
const RESUME_DELAY_MAX_MS = 90_000;

/**
 * How often to look for a wait that is due. A poll rather than one timer per
 * wait: a timer set hours ahead does not count the time a laptop spends
 * asleep, so it would fire late by however long the lid was closed.
 */
export const USAGE_LIMIT_CHECK_INTERVAL_MS = 15_000;

/** A conversation whose last turn a usage limit stopped. */
export interface UsageLimitWait {
  /** When the limit resets, in epoch milliseconds. */
  resetsAt: number;
  /**
   * When to continue, in epoch milliseconds — or null when nothing is
   * scheduled: automatic continue is off, the user cancelled it, or the reset
   * is too far out to wait for.
   */
  resumeAt: number | null;
  /** Which limit was hit, when the CLI said. */
  limitType?: string;
}

/** Whether a reset is near enough to wait for. */
export function canWaitFor(resetsAt: number, now: number): boolean {
  return resetsAt - now <= MAX_USAGE_LIMIT_WAIT_MS;
}

/** When to continue after a reset, jittered as the CLI does. */
export function resumeTimeFor(resetsAt: number, now: number, random: () => number = Math.random): number {
  const delay = RESUME_DELAY_MIN_MS + Math.floor(random() * (RESUME_DELAY_MAX_MS - RESUME_DELAY_MIN_MS));
  return Math.max(resetsAt, now) + delay;
}

/**
 * The wait for a turn a usage limit just stopped: scheduled when automatic
 * continue is on and the reset is near enough, otherwise only on record so the
 * wait can still be offered.
 */
export function waitForStop(
  stop: UsageLimitStop,
  autoContinue: boolean,
  now: number,
  random: () => number = Math.random,
): UsageLimitWait {
  const scheduled = autoContinue && canWaitFor(stop.resetsAt, now);
  return {
    resetsAt: stop.resetsAt,
    resumeAt: scheduled ? resumeTimeFor(stop.resetsAt, now, random) : null,
    ...(stop.limitType ? { limitType: stop.limitType } : {}),
  };
}

/** The same wait with a continue scheduled, or null when it cannot be. */
export function scheduleWait(
  wait: UsageLimitWait,
  now: number,
  random: () => number = Math.random,
): UsageLimitWait | null {
  if (!canWaitFor(wait.resetsAt, now)) return null;
  return { ...wait, resumeAt: resumeTimeFor(wait.resetsAt, now, random) };
}

/** Conversations whose scheduled continue is due. */
export function dueWaits(
  waits: Iterable<[string, UsageLimitWait | null]>,
  now: number,
): string[] {
  const due: string[] = [];
  for (const [conversationId, wait] of waits) {
    if (wait?.resumeAt != null && wait.resumeAt <= now) due.push(conversationId);
  }
  return due;
}

/**
 * A reset time as the user wants to read it: the time alone when it is today,
 * with the date when it is not.
 */
export function formatResetTime(at: number, now: number): string {
  const time: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return sameDay
    ? new Date(at).toLocaleTimeString([], time)
    : new Date(at).toLocaleString([], { month: 'short', day: 'numeric', ...time });
}

/**
 * What the banner says, and so which actions it offers:
 *
 *  - `waiting`: continue is scheduled and the reset has not come yet;
 *  - `resuming`: continue is scheduled and the reset has passed;
 *  - `offer`: nothing scheduled, the reset is ahead and near enough to wait for;
 *  - `ready`: nothing scheduled and the limit has already reset;
 *  - `too-far`: nothing scheduled, and the reset is too far out to wait for.
 */
export type UsageLimitBannerKind = 'waiting' | 'resuming' | 'offer' | 'ready' | 'too-far';

export interface UsageLimitBanner {
  kind: UsageLimitBannerKind;
  message: string;
}

export function usageLimitBanner(wait: UsageLimitWait, now: number): UsageLimitBanner {
  const resetTime = formatResetTime(wait.resetsAt, now);
  const hasReset = wait.resetsAt <= now;

  if (wait.resumeAt != null) {
    return hasReset
      ? { kind: 'resuming', message: 'Usage limit reset · continuing shortly' }
      : { kind: 'waiting', message: `Usage limit reached · continuing automatically at ${resetTime}` };
  }
  if (hasReset) {
    return { kind: 'ready', message: 'Usage limit has reset · continue the task where it stopped?' };
  }
  if (!canWaitFor(wait.resetsAt, now)) {
    return { kind: 'too-far', message: `Usage limit reached · resets ${resetTime}, too far out to wait for` };
  }
  return { kind: 'offer', message: `Usage limit reached · resets at ${resetTime}` };
}
