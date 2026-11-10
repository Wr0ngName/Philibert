/**
 * The schedules view's arithmetic: when each scheduled thing next happens,
 * and the list in the order it will happen.
 *
 * Two kinds of thing are scheduled. Claude Code's, in a conversation's
 * session — cron jobs (CronCreate, /loop) and one-shot wake-ups
 * (ScheduleWakeup), as the CLI lists them (SessionSchedule). And this app's
 * own: continuing a conversation after a usage limit resets (UsageLimitWait).
 *
 * Cron expressions are the CLI's: five fields, in local time — minute, hour,
 * day of month, month, day of week — each `*`, a number, a range `a-b`, a
 * step `*\/n` `a-b/n` `a/n`, or a list of those; months and days of the week
 * may be named (JAN, MON). As in cron, when both the day of month and the
 * day of week are restricted, a day matching either matches.
 */

import type { SessionSchedule } from '@shared/types';

import type { UsageLimitWait } from './usage-limit';

interface Field {
  min: number;
  max: number;
  names?: readonly string[];
}

const MINUTE: Field = { min: 0, max: 59 };
const HOUR: Field = { min: 0, max: 23 };
const DAY_OF_MONTH: Field = { min: 1, max: 31 };
const MONTH: Field = {
  min: 1, max: 12,
  names: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'],
};
/** 0 and 7 are both Sunday. */
const DAY_OF_WEEK: Field = { min: 0, max: 7, names: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] };

/** A parsed expression: the values each field matches. */
interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** Whether the day fields were restricted (not `*`): see the module's note. */
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

function value(text: string, field: Field): number {
  const named = field.names?.indexOf(text.toUpperCase()) ?? -1;
  // Names count from the field's lowest value: JAN is 1, SUN is 0.
  const n = named >= 0 ? named + field.min : /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(n) || n < field.min || n > field.max) throw new Error(`"${text}" is not a value of this field`);
  return n;
}

function parseField(text: string, field: Field): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`"${part}" has no valid step`);
    let from: number;
    let to: number;
    if (range === '*') {
      [from, to] = [field.min, field.max];
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      [from, to] = [value(a, field), value(b, field)];
      if (from > to) throw new Error(`"${range}" runs backwards`);
    } else {
      from = value(range, field);
      // "a/n" runs from a to the field's end; "a" alone is just a.
      to = stepText === undefined ? from : field.max;
    }
    for (let n = from; n <= to; n += step) values.add(n);
  }
  return values;
}

/** The expression parsed, or null when it is not one this module reads. */
export function parseCron(expression: string): Cron | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  try {
    const daysOfWeek = parseField(fields[4], DAY_OF_WEEK);
    if (daysOfWeek.delete(7)) daysOfWeek.add(0);
    return {
      minutes: parseField(fields[0], MINUTE),
      hours: parseField(fields[1], HOUR),
      daysOfMonth: parseField(fields[2], DAY_OF_MONTH),
      months: parseField(fields[3], MONTH),
      daysOfWeek,
      dayOfMonthRestricted: fields[2] !== '*',
      dayOfWeekRestricted: fields[4] !== '*',
    };
  } catch {
    return null;
  }
}

function dayMatches(cron: Cron, date: Date): boolean {
  const byMonth = cron.daysOfMonth.has(date.getDate());
  const byWeek = cron.daysOfWeek.has(date.getDay());
  if (cron.dayOfMonthRestricted && cron.dayOfWeekRestricted) return byMonth || byWeek;
  return byMonth && byWeek;
}

/** How far ahead to look before deciding an expression never matches (Feb 30th). */
const SEARCH_YEARS = 5;

/**
 * The first minute strictly after `after` that the expression matches, in
 * epoch milliseconds; null when it is unreadable or matches nothing.
 */
export function nextCronRun(expression: string, after: number): number | null {
  const cron = parseCron(expression);
  if (!cron) return null;
  const date = new Date(after);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  const limit = new Date(date);
  limit.setFullYear(limit.getFullYear() + SEARCH_YEARS);

  while (date < limit) {
    if (!cron.months.has(date.getMonth() + 1)) {
      date.setMonth(date.getMonth() + 1, 1);
      date.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(cron, date)) {
      date.setDate(date.getDate() + 1);
      date.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hours.has(date.getHours())) {
      date.setHours(date.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!cron.minutes.has(date.getMinutes())) {
      date.setMinutes(date.getMinutes() + 1, 0, 0);
      continue;
    }
    return date.getTime();
  }
  return null;
}

/** What one conversation has scheduled (the chat store's scheduleSources). */
export interface ScheduleSource {
  conversationId: string;
  sessionSchedules: SessionSchedule[];
  usageLimitWait: UsageLimitWait | null;
}

/** One line of the schedules view. */
export type ScheduleRow =
  | {
    kind: 'recurring' | 'once';
    key: string;
    conversationId: string;
    /** When it next fires; null when it cannot be told (paused, or unreadable). */
    nextRunAt: number | null;
    /** A one-shot whose time has come and that has not been reported fired yet. */
    due: boolean;
    schedule: SessionSchedule;
  }
  | {
    kind: 'usage-limit';
    key: string;
    conversationId: string;
    nextRunAt: number;
    due: boolean;
    wait: UsageLimitWait;
  };

/**
 * Every scheduled thing, soonest first; those with no time to tell —
 * paused, or with an expression not read here — last.
 */
export function scheduleRows(sources: readonly ScheduleSource[], now: number): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  for (const source of sources) {
    for (const schedule of source.sessionSchedules) {
      // A recurring job's next run is from now. A one-shot fires once, at the
      // first match after it was made: its expression matches every day.
      const next = schedule.paused
        ? null
        : nextCronRun(schedule.schedule, schedule.recurring ? now : schedule.since);
      rows.push({
        kind: schedule.recurring ? 'recurring' : 'once',
        key: `${source.conversationId}:${schedule.id}`,
        conversationId: source.conversationId,
        nextRunAt: next,
        due: !schedule.recurring && next !== null && next <= now,
        schedule,
      });
    }
    const wait = source.usageLimitWait;
    if (wait?.resumeAt != null) {
      rows.push({
        kind: 'usage-limit',
        key: `${source.conversationId}:usage-limit`,
        conversationId: source.conversationId,
        nextRunAt: wait.resumeAt,
        due: wait.resumeAt <= now,
        wait,
      });
    }
  }
  return rows.sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
}
