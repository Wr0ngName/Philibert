/**
 * Agent transcripts, read for the agent's view — on opening, and every two
 * seconds while the agent runs (useTaskDetailFeed).
 *
 * Each reading used to start from nothing: the SDK parsing the whole
 * transcript, the file parsed a second time for the messages sent to the
 * agent, and every tool result written to its file again. Measured on one of
 * 37.6 MB (1,048 messages): 0.28 s, 0.15 s and 0.07 s — for every reading,
 * including those of an agent that had finished, or had done nothing since.
 *
 * Now, per agent:
 *  - the last reading is kept with the size and time of the file it came
 *    from, and given again while the file is unchanged;
 *  - the messages sent to the agent are read from where the last reading
 *    stopped, not from the start;
 *  - a tool result already on disk is not written again: a call's result does
 *    not change once it is in the transcript.
 * What the SDK reads is not ours to make partial: it has no way to read from
 * an offset (its limit and offset count messages, after reading them all).
 */

import fs from 'node:fs';

import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';

import type { ChatMessage } from '../../../shared/types';
import { MAIN_CONSTANTS } from '../../constants/app';

import { mergeByTime, messagesSentToAgent, transcriptToMessages, type FoundImages } from './task-output';
import { toolResultFileOf, writeToolResultFile } from './tool-result-file';

interface Dependencies {
  /** The agent's transcript records, as the SDK reads them (getSubagentMessages). */
  readEntries: (sessionId: string, agentId: string, dir: string | undefined) => Promise<SessionMessage[]>;
  /** The agent's transcript file, or null when none is found. */
  locate: (sessionId: string, agentId: string) => string | null;
  /** Store the images found, attaching them to their messages. */
  storeImages: (conversationId: string, found: FoundImages[]) => Promise<void>;
}

/** Where reading the messages sent to an agent stopped, and what it had found. */
interface SentSoFar {
  offset: number;
  messages: ChatMessage[];
}

interface Reading {
  file: string;
  size: number;
  mtimeMs: number;
  messages: ChatMessage[];
  sent: SentSoFar;
}

export class AgentTranscripts {
  /** Last readings by conversation and agent, least recently used first. */
  private kept = new Map<string, Reading>();

  constructor(private readonly deps: Dependencies) {}

  /**
   * The agent's transcript as chat messages: what it was asked, what it said,
   * its calls with their results, and the messages sent to it meanwhile.
   */
  async read(conversationId: string, sessionId: string, agentId: string, dir?: string): Promise<ChatMessage[]> {
    const key = `${conversationId}\0${agentId}`;
    const file = this.deps.locate(sessionId, agentId);
    const stat = file ? statOf(file) : null;
    const before = this.kept.get(key);
    if (before && file && stat && before.file === file && before.size === stat.size && before.mtimeMs === stat.mtimeMs) {
      this.keep(key, before);
      return before.messages;
    }

    const entries = await this.deps.readEntries(sessionId, agentId, dir);
    const found: FoundImages[] = [];
    const transcript = transcriptToMessages(
      entries,
      (toolUseBlockId, content) => {
        const stored = toolResultFileOf(conversationId, toolUseBlockId);
        return fs.existsSync(stored) ? stored : writeToolResultFile(conversationId, toolUseBlockId, content);
      },
      (message, images) => found.push({ message, images }),
    );
    const sent = file ? readSentSince(file, before?.file === file ? before.sent : undefined) : undefined;
    const messages = sent ? mergeByTime(transcript, sent.messages) : transcript;
    await this.deps.storeImages(conversationId, found);

    // Kept with the file as it was before it was read: grown meanwhile, it
    // differs at the next reading, which reads it again.
    if (file && stat && sent) this.keep(key, { file, size: stat.size, mtimeMs: stat.mtimeMs, messages, sent });
    return messages;
  }

  /** Forget what was kept of a conversation's agents. */
  forget(conversationId: string): void {
    for (const key of [...this.kept.keys()]) {
      if (key.startsWith(`${conversationId}\0`)) this.kept.delete(key);
    }
  }

  private keep(key: string, reading: Reading): void {
    this.kept.delete(key);
    this.kept.set(key, reading);
    while (this.kept.size > MAIN_CONSTANTS.CLAUDE.AGENT_TRANSCRIPTS_KEPT) {
      this.kept.delete(this.kept.keys().next().value as string);
    }
  }
}

function statOf(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/**
 * The messages sent to the agent, from what was found up to `from.offset`
 * and the whole lines written since. A line the CLI is still writing — no
 * newline yet — is left for the next reading. A file shorter than where the
 * last reading stopped is not the one read before: it is read from the start.
 */
export function readSentSince(file: string, from: SentSoFar | undefined): SentSoFar {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { offset: 0, messages: [] };
  }
  const start = from && from.offset <= size ? from : { offset: 0, messages: [] };
  if (size === start.offset) return start;

  const buffer = Buffer.alloc(size - start.offset);
  const fd = fs.openSync(file, 'r');
  let read: number;
  try {
    read = fs.readSync(fd, buffer, 0, buffer.length, start.offset);
  } finally {
    fs.closeSync(fd);
  }
  const lastNewline = buffer.lastIndexOf(0x0a, read - 1);
  if (lastNewline === -1) return start;
  const lines = buffer.toString('utf-8', 0, lastNewline + 1);
  return {
    offset: start.offset + lastNewline + 1,
    messages: [...start.messages, ...messagesSentToAgent(lines)],
  };
}
