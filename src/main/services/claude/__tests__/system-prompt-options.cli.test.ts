// @vitest-environment node
// The main process's: the SDK aborts through Node's AbortSignal, which
// happy-dom's, the default here, is not.

/**
 * The system prompt the bundled Claude Code actually sends, for each choice
 * (@shared/system-prompt), through the SDK as a discussion runs in SDK mode
 * and through the CLI's own flags as channel mode runs it.
 *
 * And what a discussion is sent once the settings changed after it started:
 * the prompt it started on — resumed on other settings, and compacted on
 * them keeping recent messages — until a compaction summarizes everything,
 * after which it is sent, for good, the prompt that session started on.
 * What the app's banner for such a discussion relies on (@shared/system-prompt,
 * SDKMessageHandler.onCompacted).
 *
 * Real: the SDK, the app's bundled CLI binary, and the option and argument
 * builders under test. Fake: Anthropic's API only — a local server that keeps
 * the first request of each run and refuses it, which ends the run, or, for
 * a discussion's runs, answers each. The CLI gets a fake key and its own
 * empty config folder, never the user's.
 *
 * Channel mode drives the CLI in a terminal; its flags are the same ones run
 * here with --print, which needs no terminal.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SystemPromptChoice } from '../../../../shared/system-prompt';
import {
  BUNDLED_CLI, cliEnvironment, startFakeAnthropic, type FakeAnthropic,
} from '../../__tests__/support/fake-anthropic';
import { REAL_DISK_TEST_TIMEOUT_MS } from '../../__tests__/support/real-disk';
import { cliSystemPromptArgs, sdkSystemPrompt } from '../system-prompt-options';

const INSTRUCTIONS = 'Answer in French.\n"Quoted" and on two lines.';
/** The runs of a discussion: each of their requests answered, and all of their system prompts kept. */
const DISCUSSION = 'discussion';

let api: FakeAnthropic;
let root: string;
/** The system prompt of the request each run sent, by run. */
const sent = new Map<string, string[]>();
/** For a discussion's runs: the system prompt of each of their requests. */
const sentEach = new Map<string, string[][]>();
/** For a discussion's runs in SDK mode: what each compaction kept, as its compact_boundary said. */
const compactions = new Map<string, { preserved_segment?: unknown; preserved_messages?: unknown }[]>();
/** In a discussion's name, gives all of its replies one id: a compaction in it summarizes everything (FakeAnthropicOptions.messageId). */
const ONE_REPLY_ID = 'one reply id';

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-system-prompt-'));
  api = await startFakeAnthropic(({ run, body }) => {
    if (run && !sent.has(run)) {
      const system = body.system as { text: string }[];
      // The first block bills the request: not part of the prompt.
      sent.set(run, system.map((block) => block.text).filter((text) => !text.startsWith('x-anthropic-billing-header')));
    }
    if (!run.startsWith(DISCUSSION)) return 400;
    const system = (body.system as { text: string }[]).map((block) => block.text).filter((text) => !text.startsWith('x-anthropic-billing-header'));
    sentEach.set(run, [...(sentEach.get(run) ?? []), system]);
    // Answered, a discussion is saved, to be resumed; the summary a compaction asks for is any text.
    return [];
    // One id for every reply of the discussion, whichever of its runs.
  }, { messageId: ({ run }) => (run.includes(ONE_REPLY_ID) ? `msg_${run.slice(0, run.indexOf(ONE_REPLY_ID)).replace(/\W+/g, '_')}` : `msg_${randomUUID()}`) });
});

afterAll(async () => {
  await api.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** An environment of its own for a run, its requests marked with the run's name. */
function environment(run: string): Record<string, string> {
  return cliEnvironment(root, run, api.baseUrl);
}

/** A run of a discussion: in its own folder, shared by its runs, as a new session or resuming it. */
interface Discussion {
  home: string;
  sessionId: string;
  resume: boolean;
}

/** Messages sent one after another in one SDK session, each once the one before is answered. */
async function* oneAfterAnother(texts: string[], answered: () => Promise<void>): AsyncGenerator<SDKUserMessage> {
  for (const text of texts) {
    yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' };
    await answered();
  }
}

async function viaSdk(run: string, choice: SystemPromptChoice, discussion?: Discussion, texts = ['hello']): Promise<string[]> {
  const env = environment(discussion?.home ?? run);
  env.ANTHROPIC_CUSTOM_HEADERS = `x-test-run: ${run}`;
  const systemPrompt = sdkSystemPrompt(choice);
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 20_000);
  try {
    let answer = () => {};
    const conversation = query({
      prompt: oneAfterAnother(texts, () => new Promise<void>((resolve) => { answer = resolve; })),
      options: {
        cwd: path.join(env.HOME, 'work'),
        env,
        maxTurns: 1,
        abortController,
        pathToClaudeCodeExecutable: BUNDLED_CLI,
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        ...(discussion ? (discussion.resume ? { resume: discussion.sessionId } : { sessionId: discussion.sessionId }) : {}),
      },
    });
    let results = 0;
    for await (const message of conversation) {
      if (message.type === 'system' && message.subtype === 'compact_boundary') {
        compactions.set(run, [...(compactions.get(run) ?? []), message.compact_metadata]);
      }
      if (message.type !== 'result') continue;
      results += 1;
      if (results === texts.length) break;
      answer();
    }
    conversation.close();
  } catch {
    // The refused request ends the run in error: what was sent is what counts.
  } finally {
    clearTimeout(timer);
  }
  return sentBy(run);
}

async function viaCli(run: string, choice: SystemPromptChoice, discussion?: Discussion, texts = ['hello']): Promise<string[]> {
  const env = environment(discussion?.home ?? run);
  env.ANTHROPIC_CUSTOM_HEADERS = `x-test-run: ${run}`;
  const file = path.join(env.HOME, 'system-prompt.md');
  const args = cliSystemPromptArgs(choice, file);
  if (args) fs.writeFileSync(file, choice.instructions);
  // One --print run a message: each resumes the discussion the one before left.
  for (const [index, text] of texts.entries()) {
    const session = !discussion ? [] : discussion.resume || index > 0 ? ['--resume', discussion.sessionId] : ['--session-id', discussion.sessionId];
    await printOnce(text, [...session, ...(args ?? [])], env);
  }
  return sentBy(run);
}

function printOnce(text: string, args: string[], env: Record<string, string>): Promise<void> {
  return new Promise<void>((resolve) => {
    const cli = spawn(BUNDLED_CLI, ['--print', text, '--max-turns', '1', ...args], {
      cwd: path.join(env.HOME, 'work'),
      env,
      stdio: 'ignore',
    });
    const timer = setTimeout(() => cli.kill(), 20_000);
    cli.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function sentBy(run: string): string[] {
  const system = sent.get(run);
  if (!system) throw new Error(`The CLI sent no request for "${run}"`);
  return system;
}

describe.each([
  ['in SDK mode', viaSdk],
  ['in channel mode', viaCli],
] as const)('the system prompt sent %s', (mode, run) => {
  let minimal: string[];

  beforeAll(async () => {
    minimal = await run(`${mode} minimal`, { claudeCodePrompt: false, instructions: '' });
  }, REAL_DISK_TEST_TIMEOUT_MS);

  it('without Claude Code\'s prompt nor instructions, is a line or so of identity', () => {
    expect(minimal.join('').length).toBeGreaterThan(0);
    expect(minimal.join('').length).toBeLessThan(300);
  });

  it('without Claude Code\'s prompt, is that and the instructions, nothing else', async () => {
    const system = await run(`${mode} instructions only`, { claudeCodePrompt: false, instructions: INSTRUCTIONS });
    expect(system).toEqual([...minimal, INSTRUCTIONS]);
  }, REAL_DISK_TEST_TIMEOUT_MS);

  it('with Claude Code\'s prompt, is its whole prompt', async () => {
    const system = await run(`${mode} claude code`, { claudeCodePrompt: true, instructions: '' });
    expect(system.join('').length).toBeGreaterThan(10 * minimal.join('').length);
    expect(system.join('')).not.toContain(INSTRUCTIONS);
  }, REAL_DISK_TEST_TIMEOUT_MS);

  it('with Claude Code\'s prompt and instructions, ends on the instructions', async () => {
    const system = (await run(`${mode} claude code and instructions`, { claudeCodePrompt: true, instructions: INSTRUCTIONS })).join('');
    expect(system.length).toBeGreaterThan(10 * minimal.join('').length);
    expect(system.endsWith(`\n\n${INSTRUCTIONS}`)).toBe(true);
  }, REAL_DISK_TEST_TIMEOUT_MS);
});

const FRENCH = { claudeCodePrompt: false, instructions: 'Answer in French.' };
const GERMAN = { claudeCodePrompt: false, instructions: 'Answer in German.' };
const SPANISH = { claudeCodePrompt: false, instructions: 'Answer in Spanish.' };

describe.each([
  ['in SDK mode', viaSdk],
  ['in channel mode', viaCli],
] as const)('a discussion whose settings changed after it started, %s', (mode, run) => {
  /** A discussion started on French: runs of it resumed on other settings, each with its messages. */
  async function startedOnFrench(name: string, ...resumes: [string, SystemPromptChoice, string[]][]): Promise<void> {
    const home = `${DISCUSSION} ${mode} ${name}`;
    const sessionId = randomUUID();
    await run(home, FRENCH, { home, sessionId, resume: false });
    for (const [label, choice, texts] of resumes) await run(`${home} ${label}`, choice, { home, sessionId, resume: true }, texts);
  }

  /** The system prompt of each request a run of the discussion sent. */
  const systemsOf = (name: string, label: string) =>
    (sentEach.get(`${DISCUSSION} ${mode} ${name} ${label}`) ?? []).map((system) => system.join('\n'));
  const compactionsOf = (name: string, label: string) => compactions.get(`${DISCUSSION} ${mode} ${name} ${label}`);

  it('is sent the prompt it started on when resumed, not the settings\'', async () => {
    await startedOnFrench('resumed', ['on German', GERMAN, ['hello again']]);

    const systems = systemsOf('resumed', 'on German');
    expect(systems.length).toBeGreaterThan(0);
    for (const system of systems) expect(system).toContain(FRENCH.instructions);
    for (const system of systems) expect(system).not.toContain(GERMAN.instructions);
  }, 2 * REAL_DISK_TEST_TIMEOUT_MS);

  it('is sent it still once compacted on the settings, its recent messages kept', async () => {
    await startedOnFrench('compacted', ['on German', GERMAN, ['before compacting', '/compact', 'after compacting']]);

    if (mode === 'in SDK mode') expect(compactionsOf('compacted', 'on German')).toEqual([expect.objectContaining({ preserved_segment: expect.anything() })]);
    // The turn, the compaction's summary, the turn after it.
    const systems = systemsOf('compacted', 'on German');
    expect(systems.length).toBeGreaterThanOrEqual(3);
    for (const system of systems) expect(system).toContain(FRENCH.instructions);
    for (const system of systems) expect(system).not.toContain(GERMAN.instructions);
  }, 3 * REAL_DISK_TEST_TIMEOUT_MS);

  it('is sent, for good, the prompt it was compacted on, once a compaction summarized everything', async () => {
    const name = `compacted whole ${ONE_REPLY_ID}`;
    await startedOnFrench(
      name,
      ['on German', GERMAN, ['before compacting', '/compact', 'after compacting']],
      ['then on Spanish', SPANISH, ['later']],
    );

    if (mode === 'in SDK mode') {
      const [kept] = compactionsOf(name, 'on German') ?? [];
      expect(kept).toBeDefined();
      expect(kept!.preserved_segment).toBeUndefined();
      expect(kept!.preserved_messages).toBeUndefined();
    }
    const systems = systemsOf(name, 'on German');
    // Before: the prompt it started on, the compaction's summary too; after: the one it was compacted on.
    expect(systems[0]).toContain(FRENCH.instructions);
    expect(systems.at(-1)).toContain(GERMAN.instructions);
    expect(systems.at(-1)).not.toContain(FRENCH.instructions);
    // Recorded: later settings do not reach it either.
    for (const system of systemsOf(name, 'then on Spanish')) expect(system).toContain(GERMAN.instructions);
  }, 4 * REAL_DISK_TEST_TIMEOUT_MS);
});
