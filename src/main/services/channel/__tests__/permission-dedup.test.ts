/**
 * Feature tests: MCP primary, PTY fallback via Promise signal.
 *
 * Channel mode always has both MCP and PTY. MCP is primary — it emits
 * and resolves a signal. PTY awaits the signal: if MCP emitted, PTY
 * is suppressed; if MCP didn't emit, PTY emits as fallback.
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

function postFailure(
  port: number,
  token: string,
  convId: string,
  toolName: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ toolName });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: `/api/channel/permission/failed/${encodeURIComponent(convId)}`,
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

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('Channel mode permissions: MCP primary, PTY fallback', () => {
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

  it('MCP emits the permission dialog', async () => {
    await triggerMcp('Bash');
    expect(toolUseCalls()).toHaveLength(1);
    expect(toolUseCalls()[0][2]).toMatchObject({ toolName: 'Bash' });
  });

  it('PTY waits for MCP — does not emit on its own', async () => {
    triggerPty('Bash');
    await flushMicrotasks();
    expect(toolUseCalls()).toHaveLength(0);
  });

  it('PTY first, then MCP → MCP emits, PTY suppressed', async () => {
    triggerPty('Bash');
    await triggerMcp('Bash');
    await flushMicrotasks();

    expect(toolUseCalls()).toHaveLength(1);
    expect(toolUseCalls()[0][2]).toMatchObject({ toolName: 'Bash' });
  });

  it('MCP first, then PTY → MCP already emitted, PTY suppressed', async () => {
    await triggerMcp('Bash');
    triggerPty('Bash');
    await flushMicrotasks();

    expect(toolUseCalls()).toHaveLength(1);
  });

  it('different tools each get their own MCP emit', async () => {
    await triggerMcp('Bash');
    await triggerMcp('Read');

    expect(toolUseCalls()).toHaveLength(2);
    expect(toolUseCalls()[0][2]).toMatchObject({ toolName: 'Bash' });
    expect(toolUseCalls()[1][2]).toMatchObject({ toolName: 'Read' });
  });

  it('verdict clears signals — next MCP permission works', async () => {
    await triggerMcp('Bash');
    expect(toolUseCalls()).toHaveLength(1);

    service.handlePermissionResponse(CONV, 'mcp-1', 'allow');

    await triggerMcp('Bash');
    expect(toolUseCalls()).toHaveLength(2);
  });

  it('PTY fallback emits when MCP resolves false', async () => {
    triggerPty('Bash');

    const signal = (service as any).mcpSignals.get('Bash');
    signal.resolve(false);
    await flushMicrotasks();

    expect(toolUseCalls()).toHaveLength(1);
    expect(toolUseCalls()[0][2]).toMatchObject({ toolName: 'Bash' });
  });

  it('PTY fallback works for any tool', async () => {
    triggerPty('Read');
    (service as any).mcpSignals.get('Read').resolve(false);
    await flushMicrotasks();

    expect(toolUseCalls()).toHaveLength(1);
    expect(toolUseCalls()[0][2]).toMatchObject({ toolName: 'Read' });
  });

  it('MCP failure via bridge endpoint triggers PTY fallback', async () => {
    triggerPty('Bash');
    expect(toolUseCalls()).toHaveLength(0);

    await postFailure(bridgePort, bridgeToken, CONV, 'Bash');
    await flushMicrotasks();

    expect(toolUseCalls()).toHaveLength(1);
    expect(toolUseCalls()[0][2]).toMatchObject({ toolName: 'Bash' });
  });
});
