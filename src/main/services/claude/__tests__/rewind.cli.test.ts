// @vitest-environment node
// The main process's: the SDK aborts through Node's AbortSignal, which
// happy-dom's, the default here, is not.

/**
 * Rewinding a discussion's conversation, as the bundled Claude Code does it:
 * where the session resumes (resumePointBefore), and what Claude is then
 * sent.
 *
 * Reported: after a rewind, Claude went on with the prompt rewound away
 * from. Resumed at that prompt's own uuid, the CLI keeps the prompt — only
 * its answer goes — and the next message joins it as the same user turn.
 * Resumed at the entry before it, the prompt and everything after it go.
 *
 * Real: the SDK, the app's bundled CLI binary, the transcript it writes, and
 * the reader under test. Fake: Anthropic's API only. The CLI gets a fake key
 * and its own empty config folder, never the user's.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  BUNDLED_CLI, cliEnvironment, startFakeAnthropic, type FakeAnthropic, type ToolCall,
} from '../../__tests__/support/fake-anthropic';
import { resumePointBefore } from '../rewind-point';
import { findSessionTranscript } from '../transcript-files';

// Electron's, which writes under the app's folder: not there in tests. Hoisted
// above the imports, as every vi.mock is.
vi.mock('../../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const TEST_TIMEOUT_MS = 90_000;
/** A message that has Claude run a command before answering. */
const WITH_A_CALL = 'list the folder';
const listCall: ToolCall = { id: 'toolu_list', name: 'Bash', input: { command: 'ls', description: 'List the folder' } };

let api: FakeAnthropic;
let root: string;
/** Every request's messages, by run. */
const requests = new Map<string, unknown[][]>();

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-rewind-'));
  api = await startFakeAnthropic(({ run, body }) => {
    const messages = body.messages ?? [];
    requests.set(run, [...(requests.get(run) ?? []), messages]);
    const text = JSON.stringify(messages);
    // The call of the conversation that asks for one, until it is answered.
    if (text.includes(WITH_A_CALL) && !text.includes(`"tool_use_id":"${listCall.id}"`)) {
      return [listCall];
    }
    return [];
  });
});

afterAll(async () => {
  await api.close();
  fs.rmSync(root, { recursive: true, force: true });
});

interface Run {
  sessionId: string;
  /** The uuid each message was sent under, as the app sends them. */
  uuids: string[];
}

/** Send `texts` one after another in one session, each once the one before is answered. */
async function send(home: string, run: string, texts: string[], resume?: { sessionId: string; at: string }): Promise<Run> {
  const env = cliEnvironment(root, home, api.baseUrl);
  env.ANTHROPIC_CUSTOM_HEADERS = `x-test-run: ${run}`;
  const uuids = texts.map(() => randomUUID());
  let answered = () => {};
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    for (const [i, text] of texts.entries()) {
      yield { uuid: uuids[i], type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' };
      await new Promise<void>((resolve) => { answered = resolve; });
    }
  }
  const conversation = query({
    prompt: prompt(),
    options: {
      cwd: path.join(env.HOME, 'work'),
      env,
      pathToClaudeCodeExecutable: BUNDLED_CLI,
      enableFileCheckpointing: true,
      allowedTools: ['Bash'],
      ...(resume ? { resume: resume.sessionId, resumeSessionAt: resume.at } : {}),
    },
  });
  let sessionId = '';
  let results = 0;
  for await (const message of conversation) {
    if (message.type === 'system' && message.subtype === 'init') sessionId = message.session_id;
    if (message.type !== 'result') continue;
    expect(message.subtype, JSON.stringify(message)).toBe('success');
    results += 1;
    if (results === texts.length) break;
    answered();
  }
  conversation.close();
  return { sessionId, uuids };
}

/**
 * The conversation the run's last request sent: each message's role and
 * text. Claude Code's own context is left out: its reminders, and the
 * `system` messages it puts in the conversation (2.1.280).
 */
function lastSent(run: string): string[] {
  const messages = requests.get(run)!.at(-1) as { role: string; content: string | { type: string; text?: string; name?: string; tool_use_id?: string }[] }[];
  return messages.filter((message) => message.role !== 'system').map((message) => {
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    const parts = blocks.flatMap((block) => {
      if (block.type === 'text' && !block.text!.startsWith('<system-reminder>')) return [block.text!.trim()];
      if (block.type === 'tool_use') return [`call ${block.name}`];
      if (block.type === 'tool_result') return ['result'];
      return [];
    });
    return `${message.role}: ${parts.join(' + ')}`;
  });
}

function transcriptOf(home: string, sessionId: string): string {
  const file = findSessionTranscript(sessionId, path.join(root, home, '.claude'));
  if (!file) throw new Error(`no transcript for ${sessionId}`);
  return file;
}

describe('rewinding the conversation', () => {
  it('to a prompt, resumed before it: the prompt and everything after it are gone', async () => {
    const first = await send('before', 'before-1', ['one', 'two', 'three']);
    const at = await resumePointBefore(transcriptOf('before', first.sessionId), first.uuids[1]);
    expect(typeof at).toBe('string');

    await send('before', 'before-2', ['four'], { sessionId: first.sessionId, at: at! });

    expect(lastSent('before-2')).toEqual(['user: one', 'assistant: Done.', 'user: four']);
  }, TEST_TIMEOUT_MS);

  it("is what the prompt's own uuid fails at: the CLI keeps the prompt, the next message joined to it", async () => {
    // Why the session does not resume at the prompt rewound to. Should the
    // CLI change this, rewinding still works — this test only says why.
    const first = await send('at', 'at-1', ['one', 'two', 'three']);

    await send('at', 'at-2', ['four'], { sessionId: first.sessionId, at: first.uuids[1] });

    expect(lastSent('at-2')).toEqual(['user: one', 'assistant: Done.', 'user: two + four']);
  }, TEST_TIMEOUT_MS);

  it('to the prompt after a turn that ran a command: that turn is kept whole, its call and result', async () => {
    const first = await send('calls', 'calls-1', [WITH_A_CALL, 'two']);
    const at = await resumePointBefore(transcriptOf('calls', first.sessionId), first.uuids[1]);

    await send('calls', 'calls-2', ['three'], { sessionId: first.sessionId, at: at! });

    expect(lastSent('calls-2')).toEqual([
      `user: ${WITH_A_CALL}`, 'assistant: call Bash', 'user: result', 'assistant: Done.', 'user: three',
    ]);
  }, TEST_TIMEOUT_MS);

  it('to the first prompt: nothing to keep, so no point to resume at', async () => {
    const first = await send('first', 'first-1', ['one', 'two']);

    expect(await resumePointBefore(transcriptOf('first', first.sessionId), first.uuids[0])).toBeNull();
  }, TEST_TIMEOUT_MS);

  it('to a prompt the session has no record of: no point at all, rather than a wrong one', async () => {
    const first = await send('unknown', 'unknown-1', ['one']);
    const file = transcriptOf('unknown', first.sessionId);

    expect(await resumePointBefore(file, randomUUID())).toBeUndefined();
    // Nor an entry that is not a prompt: Claude's answer, under its own uuid.
    const answer = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type: string; uuid: string })
      .find((entry) => entry.type === 'assistant')!;
    expect(await resumePointBefore(file, answer.uuid)).toBeUndefined();
    expect(await resumePointBefore(path.join(root, 'no-such-file.jsonl'), first.uuids[0])).toBeUndefined();
  }, TEST_TIMEOUT_MS);
});
