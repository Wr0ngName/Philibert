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

/** Where a line is in the messages file: its first byte, and its length in bytes without its line end. */
export interface LineLocation {
  start: number;
  length: number;
}

/** The live messages as they stand at one moment: their ids in order, and where each one's line is. */
export interface TranscriptSnapshot {
  ids: string[];
  locations: Array<LineLocation | undefined>;
}

/**
 * Where each of these lines is, written as one batch (appendBatch) that
 * ended the file at byte `end`.
 */
export function batchLocations(lines: readonly string[], end: number): LineLocation[] {
  const lengths = lines.map((line) => Buffer.byteLength(line, 'utf-8'));
  // The batch: a line end, the lines each followed by one.
  let start = end - lengths.reduce((sum, length) => sum + length + 1, 0);
  return lengths.map((length) => {
    const location = { start, length };
    start += length + 1;
    return location;
  });
}

/**
 * What writing to a log needs to know of it, without its messages: the
 * order of the ids, a fingerprint of each message, how many records the
 * file holds, and the title its first user message gives the discussion.
 * And where each live message's line is, so a page of the discussion reads
 * only its own lines.
 *
 * Held per discussion between saves, so a save does not read the file.
 */
export class TranscriptState {
  private readonly ids: string[] = [];
  private readonly isUser: boolean[] = [];
  private readonly positions = new Map<string, number>();
  private readonly fingerprints = new Map<string, string>();
  /**
   * The line holding each live message's current version. A message
   * changed by a write not yet on disk keeps its previous line, which still
   * holds the previous version: the file is only ever appended to.
   */
  private readonly locations = new Map<string, LineLocation>();
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
      this.locations.delete(removed);
    }
    this.isUser.length = at;
    if (this.firstUser && !this.positions.has(this.firstUser.id)) this.firstUser = null;
    return true;
  }

  /** The title the first user message gives, when known. */
  get firstUserTitle(): string | undefined {
    return this.firstUser?.title;
  }

  /** Record where a live message's current line is. */
  locate(id: string, location: LineLocation): void {
    if (this.positions.has(id)) this.locations.set(id, location);
  }

  /** The live messages as they stand now; later changes to this state do not reach it. */
  snapshot(): TranscriptSnapshot {
    const ids = [...this.ids];
    return { ids, locations: ids.map((id) => this.locations.get(id)) };
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
  // In bytes, as the file is read by range: lines split on a one-byte line end.
  let next = 0;

  for (const line of text.split('\n')) {
    const start = next;
    const length = Buffer.byteLength(line, 'utf-8');
    next += length + 1;
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
      if (state.put(record.put, line) !== 'unchanged') state.locate(record.put.id, { start, length });
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

/**
 * Add a message's line to the state of a log being written one put record
 * per line, the line starting at byte `start`.
 *
 * @returns where the next line starts.
 */
export function putCompacted(state: TranscriptState, message: ChatMessage, line: string, start: number): number {
  const length = Buffer.byteLength(line, 'utf-8');
  if (state.put(message, line) !== 'unchanged') state.locate(message.id, { start, length });
  state.records += 1;
  return start + length + 1;
}

/** A log holding exactly these messages, one put record each. */
export function compactedLog(messages: readonly ChatMessage[]): { text: string; state: TranscriptState } {
  const state = new TranscriptState();
  let start = 0;
  const lines = messages.map((message) => {
    const line = recordLine({ put: message });
    start = putCompacted(state, message, line, start);
    return line;
  });
  return { text: lines.length > 0 ? `${lines.join('\n')}\n` : '', state };
}
