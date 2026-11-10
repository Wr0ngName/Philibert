/**
 * What Claude Code will do later in each discussion's session — cron jobs
 * (CronCreate, /loop) and one-shot wake-ups (ScheduleWakeup) — for the
 * schedules view.
 *
 * The CLI lists them itself, structured, at the end of every turn: the
 * `session_crons` of the SDK's Stop hook input (and SubagentStop's, at an
 * agent's). That list is the source; it is taken whole each time, so a job
 * deleted, a wake-up fired or a loop stopped leaves it without anything
 * having to be inferred. What the list does not carry — how CronCreate
 * described a job, and whether it is durable — comes from that call's own
 * structured result, when this app saw it.
 *
 * The jobs live in the session's CLI process: when it ends, they end with it,
 * except durable ones, which Claude Code keeps for when the session runs
 * again. Those stay listed, paused.
 */

import type { HookCallback, HookCallbackMatcher, HookEvent, SessionCronSummary } from '@anthropic-ai/claude-agent-sdk';

import type { SessionSchedule } from '../../../shared/types';
import logger from '../../utils/logger';

import type { CreatedCronJob } from './SDKMessageHandler';

export class SessionSchedules {
  /** Per discussion: what CronCreate said of each job it made, by job id. */
  private created = new Map<string, Map<string, CreatedCronJob>>();
  /** Per discussion: its schedules, as last listed. */
  private current = new Map<string, SessionSchedule[]>();

  constructor(private readonly emit: (conversationId: string, schedules: SessionSchedule[]) => void) {}

  /** A CronCreate call's result: kept for the job when the list names it. */
  noteCreated(conversationId: string, job: CreatedCronJob): void {
    let jobs = this.created.get(conversationId);
    if (!jobs) {
      jobs = new Map();
      this.created.set(conversationId, jobs);
    }
    jobs.set(job.id, job);
  }

  /**
   * The hooks a discussion's session is started with. They only observe:
   * the empty answer lets every turn end as it would have without them.
   */
  hooksFor(conversationId: string): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const observe: HookCallback = async (input) => {
      const crons = (input as { session_crons?: unknown }).session_crons;
      if (Array.isArray(crons)) this.listed(conversationId, crons as SessionCronSummary[]);
      return {};
    };
    return { Stop: [{ hooks: [observe] }], SubagentStop: [{ hooks: [observe] }] };
  }

  /**
   * The session's schedules, as the CLI listed them at `now`: they replace
   * what was known. One listed before keeps the time it was first listed.
   */
  listed(conversationId: string, crons: readonly SessionCronSummary[], now = Date.now()): void {
    const jobs = this.created.get(conversationId);
    const before = new Map((this.current.get(conversationId) ?? []).map((s) => [s.id, s]));
    const schedules = crons.map((cron): SessionSchedule => {
      const job = jobs?.get(cron.id);
      return {
        id: cron.id,
        schedule: cron.schedule,
        recurring: cron.recurring,
        prompt: cron.prompt,
        since: before.get(cron.id)?.since ?? now,
        ...(job && { humanSchedule: job.humanSchedule }),
        ...(job?.durable && { durable: true }),
      };
    });
    if (sameSchedules(this.current.get(conversationId), schedules)) return;
    this.current.set(conversationId, schedules);
    logger.info('Session schedules', { conversationId, schedules: schedules.map((s) => `${s.id} ${s.schedule}${s.recurring ? '' : ' (once)'}`) });
    this.emit(conversationId, schedules);
  }

  /** The session's CLI process ended: only durable jobs remain, paused. */
  sessionEnded(conversationId: string): void {
    const before = this.current.get(conversationId);
    if (!before || before.length === 0) return;
    const kept = before.filter((s) => s.durable).map((s) => ({ ...s, paused: true }));
    this.current.set(conversationId, kept);
    this.emit(conversationId, kept);
  }

  /** A discussion deleted: nothing of it is kept. */
  forget(conversationId: string): void {
    this.created.delete(conversationId);
    const had = (this.current.get(conversationId)?.length ?? 0) > 0;
    this.current.delete(conversationId);
    if (had) this.emit(conversationId, []);
  }
}

function sameSchedules(a: readonly SessionSchedule[] | undefined, b: readonly SessionSchedule[]): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}
