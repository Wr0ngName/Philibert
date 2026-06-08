/**
 * Feature tests: AskUserQuestion routing in channel mode.
 *
 * Uses real ChannelService + ChannelBridge; mocks only external boundaries
 * (electron, logger, fs, node-pty, resource paths).
 */

import * as http from 'node:http';

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test'), getName: vi.fn(() => 'test') },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((v: string) => Buffer.from(v)),
    decryptString: vi.fn((b: Buffer) => b.toString()),
  },
}));

vi.mock('electron-store', () => ({
  default: class {
    get() { return undefined; }
    set() {}
    delete() {}
    has() { return false; }
    clear() {}
    get store() { return {}; }
  },
}));

vi.mock('../../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../utils/resourcePaths', () => ({
  ClaudeCliPaths: { findBundledCli: vi.fn(() => '/usr/bin/claude') },
  ChannelPaths: { getChannelServerScript: vi.fn(() => '/tmp/channel-server.cjs') },
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => ''),
    readdirSync: vi.fn(() => []),
    rmSync: vi.fn(),
  };
});

import { IPC_CHANNELS } from '../../../../shared/types';
import type { AskUserQuestionAction } from '../../../../shared/types';
import { ChannelService } from '../ChannelService';

function makeConfigService() {
  return {
    getSelectedModel: vi.fn().mockResolvedValue('sonnet'),
    getConfig: vi.fn().mockReturnValue({}),
    hasAuth: vi.fn().mockResolvedValue(true),
    getOAuthToken: vi.fn().mockResolvedValue('sk-ant-test'),
    getOAuthCredentials: vi.fn().mockResolvedValue(null),
    getApiKey: vi.fn().mockResolvedValue(null),
  } as unknown as ConstructorParameters<typeof ChannelService>[0];
}

function makeNotificationService() {
  return {
    showPermissionRequest: vi.fn(),
    showQueryComplete: vi.fn(),
    showError: vi.fn(),
  } as unknown as ConstructorParameters<typeof ChannelService>[2];
}

function postQuestion(
  port: number,
  token: string,
  convId: string,
  payload: { requestId: string; description: string; questions: unknown[]; truncated: boolean },
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: `/api/channel/question/request/${encodeURIComponent(convId)}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode || 0 }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function pollQuestionAnswers(
  port: number,
  token: string,
  convId: string,
  timeoutSec = 2,
): Promise<{ answers: Array<{ requestId: string; cancelled?: boolean; followUpText: string }> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: `/api/channel/question/poll/${encodeURIComponent(convId)}?timeout=${timeoutSec}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString();
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

describe('Channel mode AskUserQuestion routing', () => {
  let service: ChannelService;
  let mockSendFn: ReturnType<typeof vi.fn>;
  let bridgePort: number;
  let bridgeToken: string;
  const CONV = 'q-conv';

  beforeEach(async () => {
    mockSendFn = vi.fn().mockReturnValue(true);
    const send = mockSendFn as (channel: string, ...args: unknown[]) => boolean;
    service = new ChannelService(makeConfigService(), send, makeNotificationService());
    const bridge = await service.ensureBridge();
    bridgePort = bridge.getPort();
    bridgeToken = bridge.token;
  });

  afterEach(async () => {
    await service.shutdown();
  });

  function questionEmits(): unknown[][] {
    return mockSendFn.mock.calls.filter(
      (args: unknown[]) =>
        args[0] === IPC_CHANNELS.CLAUDE_TOOL_USE &&
        (args[2] as { type: string })?.type === 'ask-user-question',
    );
  }

  it('forwards a structured question and emits an ask-user-question action', async () => {
    const payload = {
      requestId: 'q-1',
      description: 'Which library should we use?',
      truncated: false,
      questions: [
        {
          question: 'Which library should we use?',
          header: 'Library',
          multiSelect: false,
          options: [
            { label: 'axios', description: 'Popular HTTP client' },
            { label: 'fetch', description: 'Native browser API' },
          ],
        },
      ],
    };
    const res = await postQuestion(bridgePort, bridgeToken, CONV, payload);
    expect(res.status).toBe(200);
    await flushMicrotasks();

    const emits = questionEmits();
    expect(emits).toHaveLength(1);
    const action = emits[0][2] as AskUserQuestionAction;
    expect(action.toolName).toBe('AskUserQuestion');
    expect(action.id).toBe('q-1');
    expect(action.details.truncated).toBe(false);
    expect(action.details.questions).toHaveLength(1);
    expect(action.details.questions[0].options).toHaveLength(2);
  });

  it('preserves truncated state and fallbackDescription when channel preview was clipped', async () => {
    await postQuestion(bridgePort, bridgeToken, CONV, {
      requestId: 'q-2',
      description: 'answer: Pick auth method (jwt · oauth)',
      truncated: true,
      questions: [],
    });
    await flushMicrotasks();

    const emits = questionEmits();
    expect(emits).toHaveLength(1);
    const action = emits[0][2] as AskUserQuestionAction;
    expect(action.details.truncated).toBe(true);
    expect(action.details.questions).toHaveLength(0);
    expect(action.details.fallbackDescription).toContain('jwt');
  });

  it('round-trips the answer back to the channel-server poller as follow-up text', async () => {
    await postQuestion(bridgePort, bridgeToken, CONV, {
      requestId: 'q-3',
      description: 'Approach?',
      truncated: false,
      questions: [
        {
          question: 'Approach?',
          header: 'Approach',
          multiSelect: false,
          options: [
            { label: 'A', description: '' },
            { label: 'B', description: '' },
          ],
        },
      ],
    });
    await flushMicrotasks();

    service.handleQuestionAnswer({
      conversationId: CONV,
      actionId: 'q-3',
      answers: [{ question: 'Approach?', answer: 'A' }],
    });

    const polled = await pollQuestionAnswers(bridgePort, bridgeToken, CONV);
    expect(polled.answers).toHaveLength(1);
    expect(polled.answers[0].requestId).toBe('q-3');
    expect(polled.answers[0].cancelled).toBeFalsy();
    expect(polled.answers[0].followUpText).toContain('[User answered AskUserQuestion]:');
    expect(polled.answers[0].followUpText).toContain('Approach? A');
  });

  it('cancellation produces an answer with cancelled=true and empty follow-up text', async () => {
    await postQuestion(bridgePort, bridgeToken, CONV, {
      requestId: 'q-4',
      description: 'Approach?',
      truncated: false,
      questions: [
        {
          question: 'Approach?',
          header: 'Approach',
          multiSelect: false,
          options: [
            { label: 'A', description: '' },
            { label: 'B', description: '' },
          ],
        },
      ],
    });
    await flushMicrotasks();

    service.handleQuestionAnswer({
      conversationId: CONV,
      actionId: 'q-4',
      answers: [],
      cancelled: true,
    });

    const polled = await pollQuestionAnswers(bridgePort, bridgeToken, CONV);
    expect(polled.answers).toHaveLength(1);
    expect(polled.answers[0].requestId).toBe('q-4');
    expect(polled.answers[0].cancelled).toBe(true);
    expect(polled.answers[0].followUpText).toBe('');
  });

  it('multi-question answers are formatted as bullets', async () => {
    await postQuestion(bridgePort, bridgeToken, CONV, {
      requestId: 'q-5',
      description: 'Multi',
      truncated: false,
      questions: [
        {
          question: 'Q1',
          header: 'A',
          multiSelect: false,
          options: [{ label: 'one', description: '' }, { label: 'two', description: '' }],
        },
        {
          question: 'Q2',
          header: 'B',
          multiSelect: false,
          options: [{ label: 'x', description: '' }, { label: 'y', description: '' }],
        },
      ],
    });
    await flushMicrotasks();

    service.handleQuestionAnswer({
      conversationId: CONV,
      actionId: 'q-5',
      answers: [
        { question: 'Q1', answer: 'one' },
        { question: 'Q2', answer: 'y' },
      ],
    });

    const polled = await pollQuestionAnswers(bridgePort, bridgeToken, CONV);
    expect(polled.answers[0].followUpText).toContain('- Q1 one');
    expect(polled.answers[0].followUpText).toContain('- Q2 y');
  });

  it('answer for an unknown requestId is rejected (no leak into the queue)', async () => {
    // No question forwarded for this requestId.
    service.handleQuestionAnswer({
      conversationId: CONV,
      actionId: 'q-missing',
      answers: [{ question: 'Q', answer: 'A' }],
    });

    const polled = await pollQuestionAnswers(bridgePort, bridgeToken, CONV, 1);
    expect(polled.answers).toHaveLength(0);
  });
});
