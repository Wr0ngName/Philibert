// @vitest-environment node
// The main process's: the SDK aborts through Node's AbortSignal, which
// happy-dom's, the default here, is not.

/**
 * The system prompt the bundled Claude Code actually sends, for each choice
 * (@shared/system-prompt), through the SDK as a discussion runs in SDK mode
 * and through the CLI's own flags as channel mode runs it.
 *
 * Real: the SDK, the app's bundled CLI binary, and the option and argument
 * builders under test. Fake: Anthropic's API only — a local server that keeps
 * the first request it is sent and refuses it, which ends the run. The CLI
 * gets a fake key and its own empty config folder, never the user's.
 *
 * Channel mode drives the CLI in a terminal; its flags are the same ones run
 * here with --print, which needs no terminal.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SystemPromptChoice } from '../../../../shared/system-prompt';
import {
  BUNDLED_CLI, cliEnvironment, startFakeAnthropic, type FakeAnthropic,
} from '../../__tests__/support/fake-anthropic';
import { REAL_DISK_TEST_TIMEOUT_MS } from '../../__tests__/support/real-disk';
import { cliSystemPromptArgs, sdkSystemPrompt } from '../system-prompt-options';

const INSTRUCTIONS = 'Answer in French.\n"Quoted" and on two lines.';

let api: FakeAnthropic;
let root: string;
/** The system prompt of the request each run sent, by run. */
const sent = new Map<string, string[]>();

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-system-prompt-'));
  api = await startFakeAnthropic(({ run, body }) => {
    if (run && !sent.has(run)) {
      const system = body.system as { text: string }[];
      // The first block bills the request: not part of the prompt.
      sent.set(run, system.map((block) => block.text).filter((text) => !text.startsWith('x-anthropic-billing-header')));
    }
    return 400;
  });
});

afterAll(async () => {
  await api.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** An environment of its own for a run, its requests marked with the run's name. */
function environment(run: string): Record<string, string> {
  return cliEnvironment(root, run, api.baseUrl);
}

async function viaSdk(run: string, choice: SystemPromptChoice): Promise<string[]> {
  const env = environment(run);
  const systemPrompt = sdkSystemPrompt(choice);
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 20_000);
  try {
    const conversation = query({
      prompt: 'hello',
      options: {
        cwd: path.join(env.HOME, 'work'),
        env,
        maxTurns: 1,
        abortController,
        pathToClaudeCodeExecutable: BUNDLED_CLI,
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      },
    });
    for await (const message of conversation) if (message.type === 'result') break;
  } catch {
    // The refused request ends the run in error: what was sent is what counts.
  } finally {
    clearTimeout(timer);
  }
  return sentBy(run);
}

async function viaCli(run: string, choice: SystemPromptChoice): Promise<string[]> {
  const env = environment(run);
  const file = path.join(env.HOME, 'system-prompt.md');
  const args = cliSystemPromptArgs(choice, file);
  if (args) fs.writeFileSync(file, choice.instructions);
  await new Promise<void>((resolve) => {
    const cli = spawn(BUNDLED_CLI, ['--print', 'hello', '--max-turns', '1', ...(args ?? [])], {
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
  return sentBy(run);
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
