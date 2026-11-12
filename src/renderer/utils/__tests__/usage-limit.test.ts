/**
 * The rules for waiting out a usage limit.
 *
 * Getting these wrong is user-visible either way: a continue that never
 * comes, one that fires before the limit has reset and only hits it again, or
 * one scheduled days ahead for a task the user has long moved on from.
 */

import { describe, it, expect } from 'vitest';

import type { UsageLimitWait } from '@shared/types';

import { formatMoment } from '../date';
import {
  canWaitFor,
  dueWaits,
  maxUsageLimitWaitDays,
  resumeTimeFor,
  scheduleWait,
  usageLimitBanner,
  usageWarningKey,
  usageWarningMessage,
  waitForStop,
} from '../usage-limit';

const NOW = new Date(2026, 9, 26, 14, 0).getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** The setting's default, three days. */
const WAIT_DAYS = 3;

describe('canWaitFor', () => {
  it('waits for a reset up to the days set, and not beyond', () => {
    expect(canWaitFor(NOW + 3 * DAY, 3, NOW)).toBe(true);
    expect(canWaitFor(NOW + 3 * DAY + 1, 3, NOW)).toBe(false);
    expect(canWaitFor(NOW + 7 * DAY, 7, NOW)).toBe(true);
    expect(canWaitFor(NOW + DAY + 1, 1, NOW)).toBe(false);
  });

  it('waits for a reset that has already passed', () => {
    expect(canWaitFor(NOW - HOUR, 1, NOW)).toBe(true);
  });
});

describe('maxUsageLimitWaitDays', () => {
  it('lets the wait go as far as the archive delay, and no further', () => {
    expect(maxUsageLimitWaitDays(7)).toBe(7);
    expect(maxUsageLimitWaitDays(30)).toBe(7);
  });

  it('goes to a week when nothing is archived for being inactive', () => {
    expect(maxUsageLimitWaitDays(0)).toBe(7);
  });

  it('stops at a shorter archive delay', () => {
    // No such delay among the setting's choices today: the rule holds for one all the same.
    expect(maxUsageLimitWaitDays(5 as never)).toBe(5);
    expect(maxUsageLimitWaitDays(0.5 as never)).toBe(1);
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
    expect(waitForStop(stop, true, WAIT_DAYS, NOW, () => 0)).toEqual({
      resetsAt: NOW + HOUR,
      resumeAt: NOW + HOUR + 30_000,
      limitType: 'five_hour',
    });
  });

  it('only records the wait when automatic continue is off', () => {
    expect(waitForStop(stop, false, WAIT_DAYS, NOW).resumeAt).toBeNull();
  });

  it('does not schedule a reset too far out to wait for', () => {
    const far = { resetsAt: NOW + WAIT_DAYS * DAY + HOUR };
    expect(waitForStop(far, true, WAIT_DAYS, NOW).resumeAt).toBeNull();
    expect(waitForStop(far, true, 4, NOW).resumeAt).not.toBeNull();
  });
});

describe('scheduleWait', () => {
  const unscheduled: UsageLimitWait = { resetsAt: NOW + HOUR, resumeAt: null };

  it('schedules a wait the user asks for', () => {
    expect(scheduleWait(unscheduled, WAIT_DAYS, NOW, () => 0)).toEqual({ resetsAt: NOW + HOUR, resumeAt: NOW + HOUR + 30_000 });
  });

  it('refuses one too far out', () => {
    expect(scheduleWait({ resetsAt: NOW + (WAIT_DAYS + 1) * DAY, resumeAt: null }, WAIT_DAYS, NOW)).toBeNull();
  });

  it('schedules a missed one again, as no longer missed', () => {
    const missed: UsageLimitWait = { resetsAt: NOW - HOUR, resumeAt: null, missedAt: NOW - HOUR };
    expect(scheduleWait(missed, WAIT_DAYS, NOW, () => 0)).toEqual({ resetsAt: NOW - HOUR, resumeAt: NOW + 30_000 });
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

describe('usageLimitBanner', () => {
  const resetTime = formatMoment(NOW + HOUR, NOW);

  it('says when it will continue while a continue is scheduled', () => {
    expect(usageLimitBanner({ resetsAt: NOW + HOUR, resumeAt: NOW + HOUR + 30_000 }, WAIT_DAYS, NOW)).toEqual({
      kind: 'waiting',
      message: `Usage limit reached · continuing automatically at ${resetTime}`,
    });
  });

  it('says it is about to continue once the reset has passed', () => {
    expect(usageLimitBanner({ resetsAt: NOW - 1, resumeAt: NOW + 30_000 }, WAIT_DAYS, NOW).kind).toBe('resuming');
  });

  it('offers the wait when nothing is scheduled', () => {
    expect(usageLimitBanner({ resetsAt: NOW + HOUR, resumeAt: null }, WAIT_DAYS, NOW)).toEqual({
      kind: 'offer',
      message: `Usage limit reached · resets at ${resetTime}`,
    });
  });

  it('offers to continue now once the limit has reset', () => {
    expect(usageLimitBanner({ resetsAt: NOW - 1, resumeAt: null }, WAIT_DAYS, NOW).kind).toBe('ready');
  });

  it('says when a reset is too far out to wait for', () => {
    const far = NOW + WAIT_DAYS * DAY + HOUR;
    expect(usageLimitBanner({ resetsAt: far, resumeAt: null }, WAIT_DAYS, NOW)).toEqual({
      kind: 'too-far',
      message: `Usage limit reached · resets ${formatMoment(far, NOW)}, too far out to wait for`,
    });
    expect(usageLimitBanner({ resetsAt: far, resumeAt: null }, 4, NOW).kind).toBe('offer');
  });

  it('says a continue was missed while the app was closed, whatever else holds', () => {
    const resetsAt = NOW - 2 * DAY;
    expect(usageLimitBanner({ resetsAt, resumeAt: null, missedAt: NOW }, WAIT_DAYS, NOW)).toEqual({
      kind: 'missed',
      message: `Not continued: Philibert was closed when the limit reset at ${formatMoment(resetsAt, NOW)}`,
    });
  });
});

describe('usageWarningMessage', () => {
  it("says it in the CLI's words, with the limit's own name", () => {
    const resetsAt = NOW + 3 * 24 * HOUR;
    expect(usageWarningMessage({ utilization: 0.8, limitType: 'seven_day', resetsAt }, NOW))
      .toBe(`You've used 80% of your weekly limit · resets ${formatMoment(resetsAt, NOW)}`);
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
