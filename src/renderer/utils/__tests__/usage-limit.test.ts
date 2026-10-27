/**
 * The rules for waiting out a usage limit.
 *
 * Getting these wrong is user-visible either way: a continue that never
 * comes, one that fires before the limit has reset and only hits it again, or
 * one scheduled days ahead for a task the user has long moved on from.
 */

import { describe, it, expect } from 'vitest';

import {
  MAX_USAGE_LIMIT_WAIT_MS,
  canWaitFor,
  dueWaits,
  formatResetTime,
  resumeTimeFor,
  scheduleWait,
  usageLimitBanner,
  usageWarningKey,
  usageWarningMessage,
  waitForStop,
  type UsageLimitWait,
} from '../usage-limit';

const NOW = new Date(2026, 9, 26, 14, 0).getTime();
const HOUR = 60 * 60 * 1000;

describe('canWaitFor', () => {
  it('waits for a reset up to a day out, and not beyond', () => {
    expect(canWaitFor(NOW + MAX_USAGE_LIMIT_WAIT_MS, NOW)).toBe(true);
    expect(canWaitFor(NOW + MAX_USAGE_LIMIT_WAIT_MS + 1, NOW)).toBe(false);
  });

  it('waits for a reset that has already passed', () => {
    expect(canWaitFor(NOW - HOUR, NOW)).toBe(true);
  });
});

describe('resumeTimeFor', () => {
  it('continues between 30 and 90 seconds after the reset', () => {
    expect(resumeTimeFor(NOW + HOUR, NOW, () => 0)).toBe(NOW + HOUR + 30_000);
    expect(resumeTimeFor(NOW + HOUR, NOW, () => 0.999999)).toBe(NOW + HOUR + 89_999);
  });

  it('counts from now when the reset has already passed', () => {
    expect(resumeTimeFor(NOW - HOUR, NOW, () => 0)).toBe(NOW + 30_000);
  });
});

describe('waitForStop', () => {
  const stop = { resetsAt: NOW + HOUR, limitType: 'five_hour' };

  it('schedules a continue when automatic continue is on', () => {
    expect(waitForStop(stop, true, NOW, () => 0)).toEqual({
      resetsAt: NOW + HOUR,
      resumeAt: NOW + HOUR + 30_000,
      limitType: 'five_hour',
    });
  });

  it('only records the wait when automatic continue is off', () => {
    expect(waitForStop(stop, false, NOW).resumeAt).toBeNull();
  });

  it('does not schedule a reset too far out to wait for', () => {
    const far = { resetsAt: NOW + MAX_USAGE_LIMIT_WAIT_MS + HOUR };
    expect(waitForStop(far, true, NOW).resumeAt).toBeNull();
  });
});

describe('scheduleWait', () => {
  const unscheduled: UsageLimitWait = { resetsAt: NOW + HOUR, resumeAt: null };

  it('schedules a wait the user asks for', () => {
    expect(scheduleWait(unscheduled, NOW, () => 0)).toEqual({ resetsAt: NOW + HOUR, resumeAt: NOW + HOUR + 30_000 });
  });

  it('refuses one too far out', () => {
    expect(scheduleWait({ resetsAt: NOW + 2 * MAX_USAGE_LIMIT_WAIT_MS, resumeAt: null }, NOW)).toBeNull();
  });
});

describe('dueWaits', () => {
  it('names the conversations whose continue time has come, and only those', () => {
    const waits: [string, UsageLimitWait | null][] = [
      ['due', { resetsAt: NOW - HOUR, resumeAt: NOW }],
      ['later', { resetsAt: NOW, resumeAt: NOW + 1 }],
      ['unscheduled', { resetsAt: NOW - HOUR, resumeAt: null }],
      ['none', null],
    ];
    expect(dueWaits(waits, NOW)).toEqual(['due']);
  });
});

describe('formatResetTime', () => {
  it('gives the time alone for a reset later today', () => {
    const at = NOW + HOUR;
    expect(formatResetTime(at, NOW)).toBe(new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  });

  it('adds the date for a reset on another day', () => {
    const at = NOW + 30 * HOUR;
    const text = formatResetTime(at, NOW);
    expect(text).not.toBe(new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    expect(text).toContain(new Date(at).toLocaleString([], { day: 'numeric' }));
  });
});

describe('usageLimitBanner', () => {
  const resetTime = formatResetTime(NOW + HOUR, NOW);

  it('says when it will continue while a continue is scheduled', () => {
    expect(usageLimitBanner({ resetsAt: NOW + HOUR, resumeAt: NOW + HOUR + 30_000 }, NOW)).toEqual({
      kind: 'waiting',
      message: `Usage limit reached · continuing automatically at ${resetTime}`,
    });
  });

  it('says it is about to continue once the reset has passed', () => {
    expect(usageLimitBanner({ resetsAt: NOW - 1, resumeAt: NOW + 30_000 }, NOW).kind).toBe('resuming');
  });

  it('offers the wait when nothing is scheduled', () => {
    expect(usageLimitBanner({ resetsAt: NOW + HOUR, resumeAt: null }, NOW)).toEqual({
      kind: 'offer',
      message: `Usage limit reached · resets at ${resetTime}`,
    });
  });

  it('offers to continue now once the limit has reset', () => {
    expect(usageLimitBanner({ resetsAt: NOW - 1, resumeAt: null }, NOW).kind).toBe('ready');
  });

  it('says when a reset is too far out to wait for', () => {
    const far = NOW + MAX_USAGE_LIMIT_WAIT_MS + HOUR;
    expect(usageLimitBanner({ resetsAt: far, resumeAt: null }, NOW)).toEqual({
      kind: 'too-far',
      message: `Usage limit reached · resets ${formatResetTime(far, NOW)}, too far out to wait for`,
    });
  });
});

describe('usageWarningMessage', () => {
  it("says it in the CLI's words, with the limit's own name", () => {
    const resetsAt = NOW + 3 * 24 * HOUR;
    expect(usageWarningMessage({ utilization: 0.8, limitType: 'seven_day', resetsAt }, NOW))
      .toBe(`You've used 80% of your weekly limit · resets ${formatResetTime(resetsAt, NOW)}`);
    expect(usageWarningMessage({ utilization: 0.919, limitType: 'five_hour' }, NOW))
      .toBe("You've used 91% of your session limit");
  });

  it('says it is approaching when the server did not say how much is used', () => {
    expect(usageWarningMessage({ limitType: 'seven_day_opus' }, NOW)).toBe('Approaching Opus limit');
    expect(usageWarningMessage({ limitType: 'something_new' }, NOW)).toBe('Approaching usage limit');
  });
});

describe('usageWarningKey', () => {
  it('is the same as usage creeps up, and new for a new threshold, limit or period', () => {
    const warning = { utilization: 0.75, limitType: 'seven_day', resetsAt: NOW, surpassedThreshold: 0.75 };
    const key = usageWarningKey(warning);
    expect(usageWarningKey({ ...warning, utilization: 0.8 })).toBe(key);
    expect(usageWarningKey({ ...warning, surpassedThreshold: 0.9 })).not.toBe(key);
    expect(usageWarningKey({ ...warning, limitType: 'five_hour' })).not.toBe(key);
    expect(usageWarningKey({ ...warning, resetsAt: NOW + HOUR })).not.toBe(key);
  });
});
