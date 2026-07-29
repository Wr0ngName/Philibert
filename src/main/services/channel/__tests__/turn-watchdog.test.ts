/**
 * Channel-mode turn completion.
 *
 * The renderer's spinner is cleared only by CLAUDE_DONE. In channel mode the
 * turn-done debounce was armed exclusively by an incoming reply, so a turn
 * that produced no reply — tool-only work, a reply lost on the MCP channel, a
 * silent failure — armed nothing and never ended. The spinner then stayed up
 * with no way back, which matches "sometimes it does, sometimes it doesn't".
 *
 * Uses the real ChannelService + ChannelBridge; mocks only external
 * boundaries (electron, logger, fs, node-pty, resource paths).
 */

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

// node-pty is an external boundary. A fake terminal that simply stays open
// and produces nothing is exactly the scenario under test: a live session
// whose turn yields no reply.
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 4242,
    onData: (_cb: (d: string) => void) => ({ dispose() {} }),
    onExit: (_cb: (e: { exitCode: number; signal?: number }) => void) => ({ dispose() {} }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
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

const CONV = 'conv-watchdog';

function makeConfigService() {
  return {
    getSelectedModel: vi.fn().mockResolvedValue('sonnet'),
    getThinkingMode: vi.fn().mockResolvedValue('auto'),
    getStrictModelEnforcement: vi.fn().mockResolvedValue(false),
    getSwitchModelsOnFlag: vi.fn().mockResolvedValue(true),
    getConfig: vi.fn().mockReturnValue({}),
    hasAuth: vi.fn().mockResolvedValue(true),
    // Must satisfy the real AuthValidator's format checks — it is an internal
    // service and runs for real here.
    getOAuthToken: vi.fn().mockResolvedValue('sk-ant-oat01-' + 'a'.repeat(64)),
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

describe('channel mode — a turn always ends', () => {
  let service: ChannelService;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    send = vi.fn().mockReturnValue(true);
    service = new ChannelService(
      makeConfigService(),
      send as unknown as (channel: string, ...args: unknown[]) => boolean,
      makeNotificationService(),
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    await service.shutdown().catch(() => { /* best effort */ });
  });

  function doneCount(): number {
    return send.mock.calls.filter((c) => c[0] === IPC_CHANNELS.CLAUDE_DONE && c[1] === CONV).length;
  }

  /**
   * Register a live session directly. Standing up a real ChannelSession needs
   * a working PTY, a channel-server script and a bridge; none of that is what
   * this behaviour depends on, and faking those would only prove the fakes
   * work. What matters is that an armed turn always reaches done.
   */
  function registerLiveSession() {
    const active = {
      session: {
        isRunning: true,
        stop: vi.fn().mockResolvedValue(undefined),
        pid: 1,
        // Called by pollUsage when the debounce completes a turn.
        getUsage: vi.fn(() => null),
      },
      usageTimer: null,
      healthTimer: null,
      restartCount: 0,
      turnDoneTimer: null,
      turnWatchdogTimer: null,
    };
    (service as unknown as { sessions: Map<string, unknown> }).sessions.set(CONV, active);
    return active;
  }

  /**
   * The regression: a turn that produces no reply must still end. The debounce
   * is armed only by an incoming reply, so before the watchdog nothing was
   * armed at all and done never fired.
   */
  it('ends a turn that produces no reply at all', async () => {
    registerLiveSession();
    (service as unknown as { armTurnWatchdog(id: string): void }).armTurnWatchdog(CONV);

    // Must not declare the turn over while it might still be working.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(doneCount()).toBe(0);

    // ...but it cannot hang forever either.
    await vi.advanceTimersByTimeAsync(200_000);
    expect(doneCount()).toBe(1);
  });

  /** A normal turn still ends on the reply debounce, long before the watchdog. */
  it('ends a turn on the reply debounce, well before the watchdog', async () => {
    registerLiveSession();
    (service as unknown as { armTurnWatchdog(id: string): void }).armTurnWatchdog(CONV);
    (service as unknown as { handleReply(id: string, t: string): void }).handleReply(CONV, 'hi');

    await vi.advanceTimersByTimeAsync(3_000);
    expect(doneCount()).toBe(1);

    // And the watchdog must not fire a second, spurious done afterwards.
    await vi.advanceTimersByTimeAsync(200_000);
    expect(doneCount()).toBe(1);
  });
});
