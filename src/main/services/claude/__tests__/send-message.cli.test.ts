// @vitest-environment node
// The main process's: the SDK aborts through Node's AbortSignal, which
// happy-dom's, the default here, is not.

/**
 * A message the main conversation sends an agent (SendMessage), as the
 * bundled Claude Code handles it: what an agent's view relies on to show the
 * message waiting until the agent reads it.
 *
 * To a running agent, the call's structured result names the agent the
 * message waits for (queuedForAgentOf), and the agent's transcript records
 * it once read, its text as sent (messagesSentToAgent). To a finished agent,
 * the message resumes it and nothing waits: the result must name none.
 *
 * Real: the SDK, the app's bundled CLI binary, and the readers under test.
 * Fake: Anthropic's API only. The CLI gets a fake key and its own empty
 * config folder, never the user's.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  BUNDLED_CLI, cliEnvironment, startFakeAnthropic, type FakeAnthropic, type ToolCall,
} from '../../__tests__/support/fake-anthropic';
import { queuedForAgentOf } from '../SDKMessageHandler';
import { messagesSentToAgent } from '../task-output';

// Electron's, which writes under the app's folder: not there in tests. Hoisted
// above the imports, as every vi.mock is.
vi.mock('../../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const AGENT_PROMPT = 'AGENT-PROMPT keep watch';
const MESSAGE = 'Also check the X module';
const TEST_TIMEOUT_MS = 60_000;

const agentCall: ToolCall = { id: 'toolu_agent', name: 'Agent', input: { description: 'Watcher', prompt: AGENT_PROMPT, subagent_type: 'general-purpose', run_in_background: true } };

let api: FakeAnthropic;
let root: string;

/** Per run: whether the agent works a while (two tool rounds) or ends at once, and when it has ended. */
const runs = new Map<string, { agentWorks: boolean; agentEnded: Promise<void>; endAgent: () => void }>();

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-send-message-'));
  api = await startFakeAnthropic(async ({ run, body }) => {
    const script = runs.get(run);
    if (!script || !body.tools?.length) return [];
    const messages = JSON.stringify(body.messages);
    const answered = (id: string) => messages.includes(`"tool_use_id":"${id}"`);

    // The agent's own requests: its prompt, and not the main conversation's call.
    if (messages.includes(AGENT_PROMPT) && !messages.includes(`"${agentCall.id}"`)) {
      if (!script.agentWorks) {
        script.endAgent();
        return [];
      }
      if (!answered('toolu_step_1')) return [{ id: 'toolu_step_1', name: 'Bash', input: { command: 'sleep 4', description: 'First step' } }];
      if (!answered('toolu_step_2')) return [{ id: 'toolu_step_2', name: 'Bash', input: { command: 'true', description: 'Second step' } }];
      script.endAgent();
      return [];
    }

    if (!answered(agentCall.id)) return [agentCall];
    if (!messages.includes('"toolu_send"')) {
      const agentId = /agentId: ([a-z0-9]+)/.exec(messages)?.[1] ?? 'unknown';
      if (!script.agentWorks) await script.agentEnded;
      return [{ id: 'toolu_send', name: 'SendMessage', input: { to: agentId, message: MESSAGE, summary: 'check X too' } }];
    }
    return [];
  });
});

afterAll(async () => {
  await api.close();
  fs.rmSync(root, { recursive: true, force: true });
});

interface Sent {
  agentId: string;
  /** What the SendMessage's structured result says the message waits for. */
  queuedFor: string | undefined;
  /** What the agent read of the main conversation's messages, from its transcript. */
  readByAgent: string[];
}

async function sendToAgent(run: string, agentWorks: boolean): Promise<Sent> {
  let endAgent!: () => void;
  const agentEnded = new Promise<void>((resolve) => { endAgent = resolve; });
  runs.set(run, { agentWorks, agentEnded, endAgent });
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
      // Default permissions: these calls need none. Not bypassPermissions,
      // which Claude Code refuses to root — as CI's jobs run.
    },
  });

  let agentId: string | undefined;
  let result: unknown;
  let sendAnswered = false;
  try {
    for await (const message of conversation) {
      if (message.type === 'system' && message.subtype === 'task_started' && message.tool_use_id === agentCall.id) agentId = message.task_id;
      if (message.type === 'user' && Array.isArray(message.message.content)
        && message.message.content.some((block: { type?: string; tool_use_id?: string }) => block.type === 'tool_result' && block.tool_use_id === 'toolu_send')) {
        result = message.tool_use_result;
        sendAnswered = true;
      }
      // Until the agent the message went to has ended, read or resumed.
      if (sendAnswered && message.type === 'system' && message.subtype === 'task_notification' && message.task_id === agentId) break;
    }
  } finally {
    close();
    conversation.close();
  }
  if (!agentId || !sendAnswered) throw new Error('The CLI ran no agent, or the message was never answered');

  const transcript = (fs.readdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true }) as string[])
    .find((file) => file.endsWith(`agent-${agentId}.jsonl`));
  if (!transcript) throw new Error(`No transcript for agent ${agentId}`);
  const lines = fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, transcript), 'utf8');
  return { agentId, queuedFor: queuedForAgentOf(result), readByAgent: messagesSentToAgent(lines).map((m) => m.content) };
}

describe('a message to a running agent', () => {
  let sent: Sent;

  beforeAll(async () => {
    sent = await sendToAgent('running agent', true);
  }, TEST_TIMEOUT_MS);

  it('is answered as waiting for that agent, by the id its task has', () => {
    expect(sent.queuedFor).toBe(sent.agentId);
  });

  it('is in its transcript once read, its text as sent', () => {
    expect(sent.readByAgent).toEqual([MESSAGE]);
  });
});

describe('a message to an agent that has finished', () => {
  it('is answered as waiting for no one: it resumes the agent, its prompt', async () => {
    const sent = await sendToAgent('finished agent', false);

    expect(sent.queuedFor).toBeUndefined();
  }, TEST_TIMEOUT_MS);
});
