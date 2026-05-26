/**
 * Feature tests: permission deduplication between MCP and PTY paths.
 *
 * Uses real ChannelService and ChannelBridge (no internal mocking).
 * Only external boundaries are mocked: electron, logger, fs, node-pty.
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
import { ChannelService } from '../ChannelService';

function makeConfigService() {
  return {
    getSelectedModel: vi.fn().mockResolvedValue('sonnet'),
    getConfig: vi.fn().mockReturnValue({}),
    hasAuth: vi.fn().mockResolvedValue(true),
    getOAuthToken: vi.fn().mockResolvedValue('sk-ant-test'),
    getOAuthCredentials: vi.fn().mockResolvedValue(null),
    getApiKey: vi.fn().mockResolvedValue(null),
  } as any;
}

function makeNotificationService() {
  return {
    showPermissionRequest: vi.fn(),
    showQueryComplete: vi.fn(),
    showError: vi.fn(),
  } as any;
}

function postPermission(
  port: number,
  token: string,
  convId: string,
  payload: { requestId: string; toolName: string; description: string; inputPreview: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: `/api/channel/permission/request/${encodeURIComponent(convId)}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('Permission dedup: MCP first, PTY fallback', () => {
  let service: ChannelService;
  let mockSend: (channel: string, ...args: unknown[]) => boolean;
  let mockSendFn: ReturnType<typeof vi.fn>;
  let bridgePort: number;
  let bridgeToken: string;

  beforeEach(async () => {
    mockSendFn = vi.fn().mockReturnValue(true);
    mockSend = mockSendFn as (channel: string, ...args: unknown[]) => boolean;
    service = new ChannelService(makeConfigService(), mockSend, makeNotificationService());

    const bridge = await service.ensureBridge();
    bridgePort = bridge.getPort();
    bridgeToken = bridge.token;
  });

  afterEach(async () => {
    await service.shutdown();
  });

  const CONV = 'test-conv';

  function triggerPty(toolName: string, requestId = `pty-${Date.now()}`) {
    (service as any).handlePermissionRequestFromPty(
      CONV, requestId, toolName, `${toolName}(test)`, 'test',
    );
    return requestId;
  }

  async function triggerMcp(toolName: string, requestId = `mcp-${Date.now()}`) {
    await postPermission(bridgePort, bridgeToken, CONV, {
      requestId,
      toolName,
      description: `${toolName}(test)`,
      inputPreview: 'test',
    });
    return requestId;
  }

  function toolUseCalls() {
    return mockSendFn.mock.calls.filter(
      (args: unknown[]) => args[0] === IPC_CHANNELS.CLAUDE_TOOL_USE,
    );
  }

  it('MCP arrives first → PTY is suppressed', async () => {
    await triggerMcp('Bash');
    expect(toolUseCalls()).toHaveLength(1);

    triggerPty('Bash');
    await flushImmediate();

    expect(toolUseCalls()).toHaveLength(1);
  });

  it('PTY arrives when MCP did not raise → PTY emits', async () => {
    triggerPty('Bash');
    await flushImmediate();

    expect(toolUseCalls()).toHaveLength(1);
    expect(toolUseCalls()[0][2]).toMatchObject({ toolName: 'Bash' });
  });

  it('MCP arrives after PTY already emitted → MCP is suppressed', async () => {
    triggerPty('Bash');
    await flushImmediate();
    expect(toolUseCalls()).toHaveLength(1);

    await triggerMcp('Bash');
    expect(toolUseCalls()).toHaveLength(1);
  });

  it('different tools are not deduplicated', async () => {
    await triggerMcp('Bash');
    triggerPty('Read');
    await flushImmediate();

    expect(toolUseCalls()).toHaveLength(2);
    expect(toolUseCalls()[0][2]).toMatchObject({ toolName: 'Bash' });
    expect(toolUseCalls()[1][2]).toMatchObject({ toolName: 'Read' });
  });

  it('verdict clears dedup state — next permission works', async () => {
    await triggerMcp('Bash');
    expect(toolUseCalls()).toHaveLength(1);

    service.handlePermissionResponse(CONV, 'mcp-1', 'allow');

    await triggerMcp('Bash');
    expect(toolUseCalls()).toHaveLength(2);
  });

  it('only MCP — no PTY at all', async () => {
    await triggerMcp('Edit');
    expect(toolUseCalls()).toHaveLength(1);
    expect(toolUseCalls()[0][2]).toMatchObject({ toolName: 'Edit' });
  });

  it('only PTY — MCP never arrives', async () => {
    triggerPty('Write');
    await flushImmediate();

    expect(toolUseCalls()).toHaveLength(1);
    expect(toolUseCalls()[0][2]).toMatchObject({ toolName: 'Write' });
  });

  it('PTY for same tool twice after verdict — both emit', async () => {
    triggerPty('Bash');
    await flushImmediate();
    expect(toolUseCalls()).toHaveLength(1);

    service.handlePermissionResponse(CONV, 'pty-1', 'allow');

    triggerPty('Bash');
    await flushImmediate();
    expect(toolUseCalls()).toHaveLength(2);
  });
});
