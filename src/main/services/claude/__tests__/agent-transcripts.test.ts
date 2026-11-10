/**
 * Reading an agent's transcript again — on opening its view, and every two
 * seconds while it runs — without starting from nothing each time.
 * Real files in a temp directory; the SDK's reading is the fixture of a real
 * agent transcript, counted.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../../utils/logger', () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { MAIN_CONSTANTS } from '../../../constants/app';
import { AgentTranscripts, readSentSince } from '../agent-transcripts';
import { toolResultFileOf } from '../tool-result-file';

import transcriptFixture from './fixtures/agent-transcript.json';

const entries = transcriptFixture as unknown as SessionMessage[];

/** The record the CLI writes for a message reaching a running agent (2.1.280). */
function queued(uuid: string, prompt: string): string {
  return JSON.stringify({
    type: 'attachment', uuid, timestamp: '2026-11-02T21:08:42.000Z',
    attachment: { type: 'queued_command', prompt, origin: { kind: 'coordinator' } },
  });
}

let dir: string;
let file: string;
let conversation: string;
let readEntries: Mock<(sessionId: string, agentId: string, dir: string | undefined) => Promise<SessionMessage[]>>;
let transcripts: AgentTranscripts;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-transcripts-'));
  file = path.join(dir, 'agent-a1.jsonl');
  conversation = `conv-${path.basename(dir)}`;
  readEntries = vi.fn(async () => entries);
  transcripts = new AgentTranscripts({
    readEntries,
    locate: (_session, agentId) => (agentId === 'none' ? null : path.join(dir, `agent-${agentId}.jsonl`)),
    storeImages: async () => {},
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

/** Append to the transcript, moving its modification time on as a write does. */
function append(text: string): void {
  fs.appendFileSync(file, text);
  const later = new Date(fs.statSync(file).mtimeMs + 1000);
  fs.utimesSync(file, later, later);
}

describe('AgentTranscripts', () => {
  it('gives the last reading again while the file is unchanged, without reading it', async () => {
    fs.writeFileSync(file, `${queued('q1', 'Also do this')}\n`);

    const first = await transcripts.read(conversation, 'session', 'a1');
    const again = await transcripts.read(conversation, 'session', 'a1');

    expect(readEntries).toHaveBeenCalledTimes(1);
    expect(again).toBe(first);
    expect(first.map((m) => m.content)).toContain('Also do this');
  });

  it('reads again once the file has changed', async () => {
    fs.writeFileSync(file, `${queued('q1', 'Also do this')}\n`);
    await transcripts.read(conversation, 'session', 'a1');

    append(`${queued('q2', 'And this')}\n`);
    const next = await transcripts.read(conversation, 'session', 'a1');

    expect(readEntries).toHaveBeenCalledTimes(2);
    expect(next.filter((m) => m.id === 'q1' || m.id === 'q2').map((m) => m.content)).toEqual(['Also do this', 'And this']);
  });

  it('reads only what was appended for the messages sent to the agent', async () => {
    const first = queued('q1', 'Also do this');
    fs.writeFileSync(file, `${first}\n`);
    await transcripts.read(conversation, 'session', 'a1');

    // What was read before is changed in place, to the same length: a
    // reading from the start would find the new text, one from where the
    // last stopped keeps the old.
    fs.writeFileSync(file, `${queued('q1', 'Xlso do this')}\n`);
    append(`${queued('q2', 'And this')}\n`);
    const next = await transcripts.read(conversation, 'session', 'a1');

    expect(next.find((m) => m.id === 'q1')?.content).toBe('Also do this');
    expect(next.find((m) => m.id === 'q2')?.content).toBe('And this');
  });

  it('writes a tool result once, not at every reading', async () => {
    fs.writeFileSync(file, `${queued('q1', 'Also do this')}\n`);
    const first = await transcripts.read(conversation, 'session', 'a1');
    const call = first.find((m) => m.toolUse?.outputFile)!.toolUse!;
    const stored = toolResultFileOf(conversation, call.toolUseBlockId!);
    expect(call.outputFile).toBe(stored);
    fs.writeFileSync(stored, 'kept as it was');

    append(`${queued('q2', 'And this')}\n`);
    const next = await transcripts.read(conversation, 'session', 'a1');

    expect(fs.readFileSync(stored, 'utf-8')).toBe('kept as it was');
    expect(next.find((m) => m.toolUse?.toolUseBlockId === call.toolUseBlockId)?.toolUse?.outputFile).toBe(stored);
  });

  it('writes a tool result whose file has gone', async () => {
    fs.writeFileSync(file, `${queued('q1', 'Also do this')}\n`);
    const first = await transcripts.read(conversation, 'session', 'a1');
    const stored = first.find((m) => m.toolUse?.outputFile)!.toolUse!.outputFile!;
    fs.rmSync(stored);

    append('\n');
    await transcripts.read(conversation, 'session', 'a1');

    expect(fs.existsSync(stored)).toBe(true);
  });

  it('reads every time for an agent without a file', async () => {
    await transcripts.read(conversation, 'session', 'none');
    await transcripts.read(conversation, 'session', 'none');

    expect(readEntries).toHaveBeenCalledTimes(2);
  });

  it('keeps a bounded number of agents', async () => {
    const kept = MAIN_CONSTANTS.CLAUDE.AGENT_TRANSCRIPTS_KEPT;
    for (let i = 0; i <= kept; i++) {
      fs.writeFileSync(path.join(dir, `agent-x${i}.jsonl`), '\n');
      await transcripts.read(conversation, 'session', `x${i}`);
    }
    readEntries.mockClear();

    await transcripts.read(conversation, 'session', `x${kept}`);
    expect(readEntries).not.toHaveBeenCalled();
    // The first one read has been let go of.
    await transcripts.read(conversation, 'session', 'x0');
    expect(readEntries).toHaveBeenCalledTimes(1);
  });

  it("forgets a deleted conversation's agents", async () => {
    fs.writeFileSync(file, '\n');
    await transcripts.read(conversation, 'session', 'a1');

    transcripts.forget(conversation);
    await transcripts.read(conversation, 'session', 'a1');

    expect(readEntries).toHaveBeenCalledTimes(2);
  });
});

describe('readSentSince', () => {
  it('leaves a line the CLI is still writing for the next reading, then reads it whole', () => {
    const second = queued('q2', 'And this');
    fs.writeFileSync(file, `${queued('q1', 'Also do this')}\n${second.slice(0, 40)}`);

    const first = readSentSince(file, undefined);
    expect(first.messages.map((m) => m.id)).toEqual(['q1']);

    fs.appendFileSync(file, `${second.slice(40)}\n`);
    expect(readSentSince(file, first).messages.map((m) => m.id)).toEqual(['q1', 'q2']);
  });

  it('reads from the start a file shorter than where it stopped: not the one read before', () => {
    fs.writeFileSync(file, `${queued('q1', 'Also do this')}\n${queued('q2', 'And this')}\n`);
    const before = readSentSince(file, undefined);

    fs.writeFileSync(file, `${queued('q3', 'New')}\n`);

    expect(readSentSince(file, before).messages.map((m) => m.id)).toEqual(['q3']);
  });

  it('gives nothing for a missing file', () => {
    expect(readSentSince(path.join(dir, 'missing.jsonl'), undefined)).toEqual({ offset: 0, messages: [] });
  });
});
