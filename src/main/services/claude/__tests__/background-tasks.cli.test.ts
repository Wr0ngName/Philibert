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
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** The binary the app runs in development: ClaudeCliPaths.getBundledCliPaths. */
const CLI = path.resolve(__dirname, '../../../../../node_modules/@anthropic-ai/claude-code/bin/claude.exe');
/** Long enough to still be running when moved; it ends by itself after the test. */
const COMMAND = 'sleep 20';
/** Words only the agent's own requests carry: its prompt. */
const AGENT_PROMPT = 'AGENT-PROMPT wait for the build';
const TEST_TIMEOUT_MS = 60_000;

interface ToolCall { id: string; name: string; input: Record<string, unknown> }

const bash = (id: string): ToolCall => ({ id, name: 'Bash', input: { command: COMMAND, description: 'Wait for the build', timeout: 600_000 } });
// The CLI starts an agent in the background unless the call says otherwise.
const agent: ToolCall = { id: 'toolu_agent', name: 'Agent', input: { description: 'Build watcher', prompt: AGENT_PROMPT, subagent_type: 'general-purpose', run_in_background: false } };

let server: http.Server;
let baseUrl: string;
let root: string;

/** A streamed reply: the given calls, or a line of text ending the turn. */
function reply(response: http.ServerResponse, calls: ToolCall[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (event: string, data: object) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  if (calls.length === 0) {
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
  }
  calls.forEach((call, index) => {
    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } });
    send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } });
    send('content_block_stop', { type: 'content_block_stop', index });
  });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
  send('message_stop', { type: 'message_stop' });
  response.end();
}

/** What Claude calls in each run: by the main conversation, and by its agent. */
const scripts = new Map<string, { main: ToolCall; agent?: ToolCall }>();

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-background-tasks-'));
  server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      if (!request.url?.startsWith('/v1/messages') || request.url.includes('count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      const sent = JSON.parse(body) as { tools?: unknown[]; messages: unknown[] };
      const script = scripts.get(String(request.headers['x-test-run']));
      const messages = JSON.stringify(sent.messages);
      // A request with no tools is the CLI's own (a title): not Claude's turn.
      if (!script || !sent.tools?.length) return reply(response, []);
      const call = messages.includes(AGENT_PROMPT) && !messages.includes(`"${agent.id}"`) ? script.agent : script.main;
      // Called once; once its result is in, the turn ends.
      reply(response, call && !messages.includes(`"tool_use_id":"${call.id}"`) ? [call] : []);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
  const home = path.join(root, run.replace(/\W+/g, '-'));
  fs.mkdirSync(path.join(home, 'work'), { recursive: true });
  let close!: () => void;
  const closed = new Promise<void>((resolve) => { close = resolve; });
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content: 'Go' }, parent_tool_use_id: null, session_id: '' };
    await closed;
  }
  const conversation = query({
    prompt: prompt(),
    options: {
      cwd: path.join(home, 'work'),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        ANTHROPIC_API_KEY: 'sk-ant-api03-fake-key-for-tests',
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_CUSTOM_HEADERS: `x-test-run: ${run}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      pathToClaudeCodeExecutable: CLI,
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
