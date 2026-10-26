/**
 * A background task's output and an agent's transcript, for the detail view.
 *
 * The transcript fixture is what getSubagentMessages returned for a real
 * background agent (CLI 2.1.280) that read a file, started a background
 * command, ran a foreground one and reported — trimmed of its thinking
 * signatures only.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { backgroundOutputPath } from '../SDKMessageHandler';
import { MAX_TASK_OUTPUT_BYTES, isTaskOutputPath, readTaskOutput, transcriptToMessages } from '../task-output';

import transcript from './fixtures/agent-transcript.json';

const entries = transcript as unknown as SessionMessage[];

describe('transcriptToMessages', () => {
  const stored = new Map<string, string>();
  const store = (id: string, content: string): string => {
    stored.set(id, content);
    return `/results/${id}.txt`;
  };

  beforeEach(() => stored.clear());

  it('reads as the prompt, the calls made, and what the agent said', () => {
    const messages = transcriptToMessages(entries, store);

    expect(messages.map((m) => m.toolUse ? `tool:${m.toolUse.toolName}` : `${m.role}:${m.content.slice(0, 24)}`)).toEqual([
      'user:Read notes.txt, then use',
      'tool:Read',
      'tool:Bash',
      'tool:Bash',
      "assistant:Task complete. Here's wh",
    ]);
  });

  it('gives each call its result, where the tool detail view reads it', () => {
    const messages = transcriptToMessages(entries, store);
    const read = messages.find((m) => m.toolUse?.toolName === 'Read')!;

    expect(read.toolUse).toMatchObject({ status: 'executed', description: expect.stringContaining('Read: ') });
    expect(read.toolUse?.outputFile).toBe(`/results/${read.toolUse?.toolUseBlockId}.txt`);
    expect(stored.get(read.toolUse!.toolUseBlockId!)).toContain('alpha');
  });

  it('leaves a call with no result yet as running', () => {
    // The agent is still going: its last call has not come back.
    const withoutLastResult = entries.slice(0, 8);
    const messages = transcriptToMessages(withoutLastResult, store);

    expect(messages.at(-1)?.toolUse?.status).toBe('approved');
  });

  it('gives the same ids when read again, so a refresh only adds', () => {
    const first = transcriptToMessages(entries.slice(0, 6), store).map((m) => m.id);
    const again = transcriptToMessages(entries, store).map((m) => m.id);

    expect(again.slice(0, first.length)).toEqual(first);
  });

  it('dates each message from the transcript', () => {
    const messages = transcriptToMessages(entries, store);
    expect(messages[0].timestamp).toBe(Date.parse('2026-10-26T19:30:13.484Z'));
  });
});

describe('backgroundOutputPath', () => {
  it('reads the path from a background Bash result', () => {
    // Verbatim from the CLI (2.1.280).
    const text = 'Command running in background with ID: b3q51bvd7. Output is being written to: '
      + '/tmp/claude-1000/-tmp-task-probe5-t85X3t/6e5cb3ff-62ca-4def-8994-9d70a0fee155/tasks/b3q51bvd7.output. '
      + 'You will be notified when it completes. To check interim output, use Read on that file path.';
    expect(backgroundOutputPath(text)).toBe(
      '/tmp/claude-1000/-tmp-task-probe5-t85X3t/6e5cb3ff-62ca-4def-8994-9d70a0fee155/tasks/b3q51bvd7.output',
    );
  });

  it('finds nothing in an ordinary result', () => {
    expect(backgroundOutputPath('total 0\n-rw-r--r-- notes.txt')).toBeUndefined();
  });
});

describe('isTaskOutputPath', () => {
  const tmp = os.tmpdir();

  it("accepts the task's own output file under the temp directory", () => {
    expect(isTaskOutputPath(path.join(tmp, 'claude-1000', 'proj', 'sess', 'tasks', 'b1.output'), 'b1')).toBe(true);
  });

  it("refuses another task's file, another directory, or a path outside the temp directory", () => {
    expect(isTaskOutputPath(path.join(tmp, 'claude-1000', 'sess', 'tasks', 'b2.output'), 'b1')).toBe(false);
    expect(isTaskOutputPath(path.join(tmp, 'claude-1000', 'sess', 'other', 'b1.output'), 'b1')).toBe(false);
    expect(isTaskOutputPath('/home/user/.ssh/tasks/b1.output', 'b1')).toBe(false);
    expect(isTaskOutputPath(path.join(tmp, 'x', 'tasks', '..', '..', '..', 'etc', 'tasks', 'b1.output'), 'b1')).toBe(false);
  });
});

describe('readTaskOutput', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-output-test-'));
    file = path.join(dir, 'b1.output');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads what was appended since the last read', async () => {
    fs.writeFileSync(file, 'line 1\n');
    const first = await readTaskOutput(file, 0);
    fs.appendFileSync(file, 'line 2\n');
    const next = await readTaskOutput(file, first.nextByte);

    expect(first).toEqual({ text: 'line 1\n', nextByte: 7, skippedBytes: 0 });
    expect(next).toEqual({ text: 'line 2\n', nextByte: 14, skippedBytes: 0 });
  });

  it('sends only the tail of a large output, and says how much it left out', async () => {
    fs.writeFileSync(file, 'x'.repeat(MAX_TASK_OUTPUT_BYTES + 100));
    const chunk = await readTaskOutput(file, 0);

    expect(chunk.text).toHaveLength(MAX_TASK_OUTPUT_BYTES);
    expect(chunk.skippedBytes).toBe(100);
  });

  it('starts over when the file was replaced by a shorter one', async () => {
    fs.writeFileSync(file, 'new');
    expect(await readTaskOutput(file, 999)).toEqual({ text: 'new', nextByte: 3, skippedBytes: 0 });
  });
});
