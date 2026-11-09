/**
 * A discussion's messages as an append-only log.
 *
 * The discussion used to be one JSON document rewritten whole on every save:
 * a save of a 68,144-message discussion rewrote tens of megabytes, long
 * enough for a quit to land in the middle and leave the file cut (see
 * durable-file). Here a save adds lines for what changed, so it writes
 * kilobytes, and nothing already written is ever written over.
 *
 * Each line is one record:
 *
 * - `{"put": message}` — the message, replacing the one with its id where it
 *   stands, or added at the end when its id is new;
 * - `{"cut": id}` — the message with that id and every one after it removed,
 *   as a rewind does.
 *
 * Reading plays the records in order. A line that is not a whole record is
 * a write that was stopped part-way: it is skipped, and the lines after it
 * still count, because every batch of records starts on a line of its own.
 * Records a later one replaced are dropped when the log is rewritten
 * (compacted) to its live messages.
 */

import { createHash } from 'node:crypto';

import { titleFromMessages } from '../../shared/conversation-title';
import type { ChatMessage } from '../../shared/types';

export type LogRecord = { put: ChatMessage } | { cut: string };

/** A record as the line that stores it. */
export function recordLine(record: LogRecord): string {
  return JSON.stringify(record);
}

/**
 * Lines as one append: on a line of their own even after a write stopped
 * part-way, which left the file without its last line end.
 */
export function appendBatch(lines: string[]): string {
  return `\n${lines.join('\n')}\n`;
}

/**
 * What tells two stored versions of a message apart, kept instead of the
 * message: a save sends the whole window the renderer holds, a thousand
 * messages or more, and only those whose line differs are written.
 */
export function fingerprintOf(line: string): string {
  return createHash('sha1').update(line).digest('base64');
}

export type PutOutcome = 'added' | 'changed' | 'unchanged';

/**
 * What writing to a log needs to know of it, without its messages: the
 * order of the ids, a fingerprint of each message, how many records the
 * file holds, and the title its first user message gives the discussion.
 *
 * Held per discussion between saves, so a save does not read the file.
 */
export class TranscriptState {
  private readonly ids: string[] = [];
  private readonly isUser: boolean[] = [];
  private readonly positions = new Map<string, number>();
  private readonly fingerprints = new Map<string, string>();
  /** Lines in the file that are whole records, replaced ones included. */
  records = 0;
  /**
   * The first user message and the title it gives, which the discussions
   * list shows until the discussion is renamed (titleFromMessages).
   * `title` is undefined when that message is not one this state was given
   * the content of, or gives no title.
   */
  private firstUser: { id: string; title: string | undefined } | null = null;

  get size(): number {
    return this.ids.length;
  }

  /** Where a message stands, or -1. */
  indexOf(id: string): number {
    return this.positions.get(id) ?? -1;
  }

  /** Apply a put record. */
  put(message: ChatMessage, line: string): PutOutcome {
    const fingerprint = fingerprintOf(line);
    const at = this.positions.get(message.id);
    const user = message.role === 'user';
    let outcome: PutOutcome;

    if (at === undefined) {
      this.positions.set(message.id, this.ids.length);
      this.ids.push(message.id);
      this.isUser.push(user);
      outcome = 'added';
    } else {
      if (this.fingerprints.get(message.id) === fingerprint) return 'unchanged';
      this.isUser[at] = user;
      outcome = 'changed';
    }
    this.fingerprints.set(message.id, fingerprint);

    if (user && (this.firstUser === null || this.firstUser.id === message.id)) {
      this.firstUser = { id: message.id, title: titleFromMessages([message]) };
    } else if (!user && this.firstUser?.id === message.id) {
      // No longer a user message: the first user message is a later one,
      // whose content this state does not keep.
      const next = this.isUser.indexOf(true);
      this.firstUser = next === -1 ? null : { id: this.ids[next], title: undefined };
    }
    return outcome;
  }

  /** Apply a cut record: drop the message and every one after it. False when there is no such message. */
  cut(id: string): boolean {
    const at = this.positions.get(id);
    if (at === undefined) return false;
    for (const removed of this.ids.splice(at)) {
      this.positions.delete(removed);
      this.fingerprints.delete(removed);
    }
    this.isUser.length = at;
    if (this.firstUser && !this.positions.has(this.firstUser.id)) this.firstUser = null;
    return true;
  }

  /** The title the first user message gives, when known. */
  get firstUserTitle(): string | undefined {
    return this.firstUser?.title;
  }
}

export interface Replayed {
  messages: ChatMessage[];
  state: TranscriptState;
  /** Lines that were not whole records: writes stopped part-way. */
  damaged: number;
}

function isPut(record: unknown): record is { put: ChatMessage } {
  const put = (record as { put?: unknown }).put as ChatMessage | undefined;
  return typeof put === 'object' && put !== null && typeof put.id === 'string';
}

function isCut(record: unknown): record is { cut: string } {
  return typeof (record as { cut?: unknown }).cut === 'string';
}

/** A log's messages, and the state for writing after it; see the top of this file. */
export function replay(text: string): Replayed {
  const messages: ChatMessage[] = [];
  const state = new TranscriptState();
  let damaged = 0;

  for (const line of text.split('\n')) {
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      damaged += 1;
      continue;
    }

    if (isPut(record)) {
      const at = state.indexOf(record.put.id);
      state.put(record.put, line);
      if (at === -1) messages.push(record.put);
      else messages[at] = record.put;
    } else if (isCut(record)) {
      const at = state.indexOf(record.cut);
      if (state.cut(record.cut)) messages.length = at;
    } else {
      damaged += 1;
      continue;
    }
    state.records += 1;
  }

  return { messages, state, damaged };
}

/** A log holding exactly these messages, one put record each. */
export function compactedLog(messages: readonly ChatMessage[]): { text: string; state: TranscriptState } {
  const state = new TranscriptState();
  const lines = messages.map((message) => {
    const line = recordLine({ put: message });
    state.put(message, line);
    return line;
  });
  state.records = lines.length;
  return { text: lines.length > 0 ? `${lines.join('\n')}\n` : '', state };
}
