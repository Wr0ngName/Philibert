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

import { MAX_TASK_OUTPUT_BYTES, cliTempRoot, locateTaskOutput, readTaskOutput, transcriptToMessages } from '../task-output';

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

describe('locateTaskOutput', () => {
  const SESSION = '6cfb63b6-b4b2-4d47-8dee-4c3563db912d';
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-tmp-test-'));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  /** The layout the CLI made under CLAUDE_CODE_TMPDIR (2.1.280, measured). */
  function writeOutput(sessionId: string, taskId: string, base = root): string {
    const dir = path.join(base, 'claude-1000', '-tmp-task-probe6-l2P6Hd', sessionId, 'tasks');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${taskId}.output`);
    fs.writeFileSync(file, 'line 1\n');
    return file;
  }

  it('finds a running command by its session and task ids', async () => {
    const file = writeOutput(SESSION, 'bl6zrfn7y');
    expect(await locateTaskOutput(root, SESSION, 'bl6zrfn7y')).toBe(file);
  });

  it("does not take another session's task, or a task that has no file yet", async () => {
    writeOutput('another-session', 'bl6zrfn7y');
    expect(await locateTaskOutput(root, SESSION, 'bl6zrfn7y')).toBeUndefined();
    writeOutput(SESSION, 'other-task');
    expect(await locateTaskOutput(root, SESSION, 'bl6zrfn7y')).toBeUndefined();
  });

  it('does not follow a link out of the temp root', async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-'));
    try {
      writeOutput(SESSION, 'bl6zrfn7y', elsewhere);
      fs.symlinkSync(path.join(elsewhere, 'claude-1000'), path.join(root, 'claude-1000'));
      expect(await locateTaskOutput(root, SESSION, 'bl6zrfn7y')).toBeUndefined();
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('finds nothing in a root that does not exist', async () => {
    expect(await locateTaskOutput(path.join(root, 'missing'), SESSION, 'x')).toBeUndefined();
  });
});

describe('cliTempRoot', () => {
  const saved = process.env.CLAUDE_CODE_TMPDIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
    else process.env.CLAUDE_CODE_TMPDIR = saved;
  });

  it("is the app's own directory, unless the user chose one", () => {
    delete process.env.CLAUDE_CODE_TMPDIR;
    expect(cliTempRoot()).toBe(path.join(os.tmpdir(), 'philibert-cli'));
    process.env.CLAUDE_CODE_TMPDIR = '/srv/my-tmp';
    expect(cliTempRoot()).toBe('/srv/my-tmp');
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
