/**
 * What each discussion's session will do later, from the Stop hook's
 * `session_crons` — shaped here as the bundled CLI was measured to send it:
 * a CronCreate job and a ScheduleWakeup wake-up after one turn.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { SessionSchedule } from '../../../../shared/types';
import { SessionSchedules } from '../SessionSchedules';

const JOB = { id: '6cf46d13', schedule: '*/5 * * * *', recurring: true, prompt: 'check the fleet' };
const WAKE = { id: 'f37b8a54', schedule: '54 1 * * *', recurring: false, prompt: 'check the build' };

let emitted: [string, SessionSchedule[]][];
let schedules: SessionSchedules;

beforeEach(() => {
  emitted = [];
  schedules = new SessionSchedules((conversationId, list) => emitted.push([conversationId, list]));
});

/** Run the Stop hook the session was given, as the SDK calls it. */
async function stop(conversationId: string, sessionCrons: unknown, event: 'Stop' | 'SubagentStop' = 'Stop') {
  const [matcher] = schedules.hooksFor(conversationId)[event] ?? [];
  return matcher.hooks[0]({ hook_event_name: event, session_crons: sessionCrons } as never, undefined, { signal: new AbortController().signal });
}

describe('SessionSchedules', () => {
  it('reports what the Stop hook lists, and lets the turn end as it would', async () => {
    const answer = await stop('conv', [JOB, WAKE]);

    expect(answer).toEqual({});
    expect(emitted).toHaveLength(1);
    expect(emitted[0][0]).toBe('conv');
    expect(emitted[0][1].map((s) => [s.id, s.schedule, s.recurring, s.prompt])).toEqual([
      ['6cf46d13', '*/5 * * * *', true, 'check the fleet'],
      ['f37b8a54', '54 1 * * *', false, 'check the build'],
    ]);
  });

  it("listens at an agent's end too", async () => {
    await stop('conv', [JOB], 'SubagentStop');

    expect(emitted.map(([, list]) => list.map((s) => s.id))).toEqual([['6cf46d13']]);
  });

  it('adds what CronCreate said of a job: how it repeats, and whether it is kept', async () => {
    schedules.noteCreated('conv', { id: '6cf46d13', humanSchedule: 'Every 5 minutes', durable: true });

    await stop('conv', [JOB]);

    expect(emitted[0][1][0]).toMatchObject({ humanSchedule: 'Every 5 minutes', durable: true });
  });

  it('keeps the time a schedule was first listed, which a one-shot fires after', () => {
    schedules.listed('conv', [WAKE], 1_000);
    schedules.listed('conv', [JOB, WAKE], 5_000);

    expect(emitted.at(-1)![1].map((s) => [s.id, s.since])).toEqual([['6cf46d13', 5_000], ['f37b8a54', 1_000]]);
  });

  it('takes each list whole: what it no longer lists is gone', () => {
    schedules.listed('conv', [JOB, WAKE], 1_000);
    schedules.listed('conv', [JOB], 2_000);

    expect(emitted.at(-1)![1].map((s) => s.id)).toEqual(['6cf46d13']);
  });

  it('says nothing when the list did not change', () => {
    schedules.listed('conv', [JOB], 1_000);
    schedules.listed('conv', [JOB], 2_000);

    expect(emitted).toHaveLength(1);
  });

  it('ignores a hook input without a list', async () => {
    await stop('conv', undefined);

    expect(emitted).toEqual([]);
  });

  it('keeps only durable jobs when the session ends, paused', () => {
    schedules.noteCreated('conv', { id: '6cf46d13', humanSchedule: 'Every 5 minutes', durable: true });
    schedules.listed('conv', [JOB, WAKE], 1_000);

    schedules.sessionEnded('conv');

    expect(emitted.at(-1)![1].map((s) => [s.id, s.paused])).toEqual([['6cf46d13', true]]);
  });

  it('forgets a deleted discussion, saying so once', () => {
    schedules.listed('conv', [JOB], 1_000);

    schedules.forget('conv');
    schedules.forget('conv');

    expect(emitted.at(-1)).toEqual(['conv', []]);
    expect(emitted).toHaveLength(2);
  });

  it('keeps one discussion out of another', () => {
    schedules.listed('a', [JOB], 1_000);
    schedules.listed('b', [WAKE], 1_000);
    schedules.sessionEnded('a');

    expect(emitted.at(-1)).toEqual(['a', []]);
    expect(emitted.filter(([id]) => id === 'b')).toHaveLength(1);
  });
});
