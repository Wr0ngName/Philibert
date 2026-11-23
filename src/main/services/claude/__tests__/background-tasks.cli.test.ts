// @vitest-environment node
// The main process's: the SDK aborts through Node's AbortSignal, which
// happy-dom's, the default here, is not.

/**
 * Sending a task running in the foreground to the background, as the bundled
 * Claude Code does it: what the details' "Send to background" relies on.
 *
 * The app asks `backgroundTasks(toolUseId)` by the call that started the
 * task, then waits for the CLI to mark the task backgrounded — the
 * `task_updated` patch the app moves it on — and tells the user when the SDK
 * answers false. Each of those is checked here, for a command, an agent, and
 * a command an agent runs: the three kinds of foreground task.
 *
 * Real: the SDK and the app's bundled CLI binary. Fake: Anthropic's API only —
 * a local server that has Claude call the tool, then end its turn. The CLI
 * gets a fake key and its own empty config folder, never the user's.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BUNDLED_CLI, cliEnvironment, startFakeAnthropic, type FakeAnthropic, type ToolCall,
} from '../../__tests__/support/fake-anthropic';

/** Long enough to still be running when moved; it ends by itself after the test. */
const COMMAND = 'sleep 20';
/** Words only the agent's own requests carry: its prompt. */
const AGENT_PROMPT = 'AGENT-PROMPT wait for the build';
const TEST_TIMEOUT_MS = 60_000;

const bash = (id: string): ToolCall => ({ id, name: 'Bash', input: { command: COMMAND, description: 'Wait for the build', timeout: 600_000 } });
// The CLI starts an agent in the background unless the call says otherwise.
const agent: ToolCall = { id: 'toolu_agent', name: 'Agent', input: { description: 'Build watcher', prompt: AGENT_PROMPT, subagent_type: 'general-purpose', run_in_background: false } };

let api: FakeAnthropic;
let root: string;

/** What Claude calls in each run: by the main conversation, and by its agent. */
const scripts = new Map<string, { main: ToolCall; agent?: ToolCall }>();

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-background-tasks-'));
  api = await startFakeAnthropic(({ run, body }) => {
    const script = scripts.get(run);
    const messages = JSON.stringify(body.messages);
    // A request with no tools is the CLI's own (a title): not Claude's turn.
    if (!script || !body.tools?.length) return [];
    const call = messages.includes(AGENT_PROMPT) && !messages.includes(`"${agent.id}"`) ? script.agent : script.main;
    // Called once; once its result is in, the turn ends.
    return call && !messages.includes(`"tool_use_id":"${call.id}"`) ? [call] : [];
  });
});

afterAll(async () => {
  await api.close();
  fs.rmSync(root, { recursive: true, force: true });
});

interface Run {
  /** The task the call started, as the CLI announced it. */
  started: Extract<SDKMessage, { subtype: 'task_started' }>;
  /** What backgroundTasks answered: for the call, again for it, for no call. */
  answers: boolean[];
  /** The patches the CLI sent for the task after it was asked. */
  patches: Record<string, unknown>[];
}

/** Run a turn whose `target` call is sent to the background once its task starts. */
async function sendToBackground(run: string, script: { main: ToolCall; agent?: ToolCall }, target: string): Promise<Run> {
  scripts.set(run, script);
  const env = cliEnvironment(root, run, api.baseUrl);
  let close!: () => void;
  const closed = new Promise<void>((resolve) => { close = resolve; });
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content: 'Go' }, parent_tool_use_id: null, session_id: '' };
    await closed;
  }
  const conversation = query({
    prompt: prompt(),
    options: {
      cwd: path.join(env.HOME, 'work'),
      env,
      pathToClaudeCodeExecutable: BUNDLED_CLI,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    },
  });

  let started: Run['started'] | undefined;
  let asked: Promise<boolean[]> | undefined;
  const patches: Record<string, unknown>[] = [];
  try {
    for await (const message of conversation) {
      if (message.type === 'system' && message.subtype === 'task_started' && message.tool_use_id === target && !started) {
        started = message;
        asked = (async () => [
          await conversation.backgroundTasks(target),
          await conversation.backgroundTasks(target),
          await conversation.backgroundTasks('toolu_no_such_call'),
        ])();
      }
      if (message.type === 'system' && message.subtype === 'task_updated' && message.task_id === started?.task_id) {
        patches.push(message.patch as Record<string, unknown>);
      }
      // The turn goes on without waiting for the task: its end is Claude's reply.
      if (message.type === 'result') break;
    }
  } finally {
    close();
    conversation.close();
  }
  if (!started || !asked) throw new Error(`The CLI started no task for ${target}`);
  return { started, answers: await asked, patches };
}

describe.each([
  ['a command', { main: bash('toolu_bash') }, 'toolu_bash'],
  ['an agent', { main: agent, agent: bash('toolu_agent_bash') }, agent.id],
  ["an agent's command", { main: agent, agent: bash('toolu_agent_bash') }, 'toolu_agent_bash'],
] as const)('sending %s in the foreground to the background', (kind, script, target) => {
  let run: Run;

  beforeAll(async () => {
    run = await sendToBackground(kind, script, target);
  }, TEST_TIMEOUT_MS);

  it('finds it running in the foreground, under the call that started it', () => {
    expect(run.started.is_backgrounded).toBe(false);
  });

  it('is answered true, then false once it is no longer in the foreground, and false for no call', () => {
    expect(run.answers).toEqual([true, false, false]);
  });

  it('is followed by the CLI marking the task backgrounded, which the app moves it on', () => {
    expect(run.patches).toContainEqual({ is_backgrounded: true });
  });
});
