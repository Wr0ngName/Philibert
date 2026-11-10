/**
 * When each scheduled thing next happens, and in what order the schedules
 * view lists them. Times are built in local time, as cron reads them.
 */

import { describe, it, expect } from 'vitest';

import type { SessionSchedule } from '@shared/types';

import { nextCronRun, parseCron, scheduleRows, type ScheduleSource } from '../schedules';

/** A local time, as epoch milliseconds. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

describe('nextCronRun', () => {
  it('finds the next of a step: every 5 minutes, as CronCreate made it', () => {
    expect(nextCronRun('*/5 * * * *', at(2026, 11, 10, 1, 44, 30))).toBe(at(2026, 11, 10, 1, 45));
    // Strictly after: on a match, the next one.
    expect(nextCronRun('*/5 * * * *', at(2026, 11, 10, 1, 45))).toBe(at(2026, 11, 10, 1, 50));
  });

  it('finds a single daily time, as ScheduleWakeup encodes one', () => {
    expect(nextCronRun('54 1 * * *', at(2026, 11, 10, 1, 44))).toBe(at(2026, 11, 10, 1, 54));
    expect(nextCronRun('54 1 * * *', at(2026, 11, 10, 2, 0))).toBe(at(2026, 11, 11, 1, 54));
  });

  it('reads ranges, lists and stepped ranges', () => {
    expect(nextCronRun('0 9-17/4 * * *', at(2026, 11, 10, 9, 30))).toBe(at(2026, 11, 10, 13, 0));
    expect(nextCronRun('15,45 * * * *', at(2026, 11, 10, 10, 20))).toBe(at(2026, 11, 10, 10, 45));
  });

  it('reads weekdays, by number or name, Sunday as 0 or 7', () => {
    // 2026-11-10 is a Tuesday.
    expect(nextCronRun('0 9 * * 1-5', at(2026, 11, 13, 10, 0))).toBe(at(2026, 11, 16, 9, 0));
    expect(nextCronRun('0 9 * * MON', at(2026, 11, 10, 10, 0))).toBe(at(2026, 11, 16, 9, 0));
    expect(nextCronRun('0 9 * * 7', at(2026, 11, 10))).toBe(at(2026, 11, 15, 9, 0));
    expect(nextCronRun('0 9 * * 0', at(2026, 11, 10))).toBe(at(2026, 11, 15, 9, 0));
  });

  it('matches either day field when both are restricted, as cron does', () => {
    // The 20th, or any Monday: Monday the 16th comes first.
    expect(nextCronRun('0 0 20 * 1', at(2026, 11, 10))).toBe(at(2026, 11, 16));
  });

  it('crosses months and years, and finds the next February 29th', () => {
    expect(nextCronRun('0 0 1 JAN *', at(2026, 11, 10))).toBe(at(2027, 1, 1));
    expect(nextCronRun('0 12 29 2 *', at(2026, 11, 10))).toBe(at(2028, 2, 29, 12, 0));
  });

  it('says nothing for an expression it cannot read, or one that never matches', () => {
    expect(nextCronRun('@hourly', at(2026, 11, 10))).toBeNull();
    expect(nextCronRun('61 * * * *', at(2026, 11, 10))).toBeNull();
    expect(nextCronRun('* * * *', at(2026, 11, 10))).toBeNull();
    expect(nextCronRun('0 0 30 2 *', at(2026, 11, 10))).toBeNull();
    expect(parseCron('5-1 * * * *')).toBeNull();
  });
});

describe('scheduleRows', () => {
  const NOW = at(2026, 11, 10, 1, 44);

  function schedule(overrides: Partial<SessionSchedule>): SessionSchedule {
    return { id: 'job', schedule: '*/5 * * * *', recurring: true, prompt: 'check the fleet', since: NOW - 60_000, ...overrides };
  }

  function source(conversationId: string, sessionSchedules: SessionSchedule[], resumeAt: number | null = null): ScheduleSource {
    return { conversationId, sessionSchedules, usageLimitWait: resumeAt === null ? null : { resetsAt: resumeAt - 30_000, resumeAt } };
  }

  it('lists everything, in every discussion, soonest first', () => {
    const rows = scheduleRows([
      source('a', [schedule({ id: 'wake', schedule: '54 1 * * *', recurring: false })]),
      source('b', [schedule({ id: 'job' })], at(2026, 11, 10, 3, 0)),
    ], NOW);

    expect(rows.map((r) => [r.kind, r.conversationId, r.nextRunAt])).toEqual([
      ['recurring', 'b', at(2026, 11, 10, 1, 45)],
      ['once', 'a', at(2026, 11, 10, 1, 54)],
      ['usage-limit', 'b', at(2026, 11, 10, 3, 0)],
    ]);
  });

  it('tells a one-shot its time from when it was made, and calls it due once that passed', () => {
    // Made at 01:44 for 01:54; it is 02:10 and no turn has reported it fired.
    const [row] = scheduleRows([source('a', [schedule({ schedule: '54 1 * * *', recurring: false, since: NOW })])], at(2026, 11, 10, 2, 10));

    expect(row.nextRunAt).toBe(at(2026, 11, 10, 1, 54));
    expect(row.due).toBe(true);
  });

  it('puts a paused job last, with no time', () => {
    const rows = scheduleRows([
      source('a', [schedule({ id: 'kept', paused: true, durable: true })]),
      source('b', [schedule({ id: 'live' })]),
    ], NOW);

    expect(rows.map((r) => [r.key, r.nextRunAt])).toEqual([['b:live', at(2026, 11, 10, 1, 45)], ['a:kept', null]]);
  });

  it('leaves out a usage-limit wait with nothing scheduled', () => {
    expect(scheduleRows([{ conversationId: 'a', sessionSchedules: [], usageLimitWait: { resetsAt: NOW, resumeAt: null } }], NOW)).toEqual([]);
  });
});
