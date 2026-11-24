/**
 * Channel mode: what the renderer is told the CLI recorded for a discussion
 * (@shared/system-prompt) — the prompt a new discussion starts on, and
 * nothing for one resumed, whose CLI keeps what it recorded.
 *
 * Real: ClaudeCodeService, ChannelService, ChannelBridge, ChannelSession
 * writing its files in a temporary folder, ConfigService, and git about the
 * discussion's folder. Mocked, as external boundaries: electron,
 * electron-store, the logger, resource paths, the IPC sender, and node-pty —
 * a terminal that records how it was started and exits when killed.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockStoreData, mockSend, paths, terminals, spawnPty } = vi.hoisted(() => {
  /** Each terminal started: its arguments, whether it was killed, and a way to have it exit by itself. */
  const terminals: { args: string[]; killed: boolean; exit: () => void }[] = [];
  return {
    mockStoreData: {} as Record<string, unknown>,
    mockSend: vi.fn(),
    paths: { sessions: '' },
    terminals,
    spawnPty: vi.fn((_file: string, args: string[]) => {
      // node-pty's exit event: an exit code, and a signal when killed by one.
      const exits: ((event: { exitCode: number; signal?: number }) => void)[] = [];
      let exited = false;
      const terminal = {
        args,
        killed: false,
        exit: () => {
          exited = true;
          exits.splice(0).forEach((exit) => exit({ exitCode: 0 }));
        },
      };
      terminals.push(terminal);
      return {
        pid: 4242,
        onData: () => ({ dispose() {} }),
        onExit: (callback: (event: { exitCode: number; signal?: number }) => void) => {
          if (exited) callback({ exitCode: 0 });
          else exits.push(callback);
          return { dispose() {} };
        },
        write: vi.fn(),
        resize: vi.fn(),
        kill: () => {
          terminal.killed = true;
          terminal.exit();
        },
      };
    }),
  };
});

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), getName: vi.fn(() => 'test') },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() },
  BrowserWindow: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
    decryptString: vi.fn((buffer: Buffer) => buffer.toString().slice('encrypted:'.length)),
  },
  dialog: { showMessageBox: vi.fn() },
}));

vi.mock('electron-store', () => ({
  default: class MockStore {
    constructor(opts?: { defaults?: Record<string, unknown> }) {
      Object.assign(mockStoreData, opts?.defaults || {});
    }
    get(key: string, defaultValue?: unknown) {
      return key in mockStoreData ? mockStoreData[key] : defaultValue;
    }
    set(key: string, value: unknown) { mockStoreData[key] = value; }
    delete(key: string) { delete mockStoreData[key]; }
    clear() { for (const key of Object.keys(mockStoreData)) delete mockStoreData[key]; }
    get store() { return { ...mockStoreData }; }
  },
}));

vi.mock('../../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogLevel: vi.fn(),
}));

vi.mock('../../../utils/resourcePaths', () => ({
  ClaudeCliPaths: { findBundledCli: vi.fn(() => '/bundled/claude') },
  ChannelPaths: { getChannelServerScript: vi.fn(() => '/channel-server.cjs') },
  getChannelSessionsDir: () => paths.sessions,
  WindowsPaths: {
    hasBundledGit: () => false,
    getGitExe: () => 'git',
    hasBundledGitBash: vi.fn(() => false),
    getBashExe: vi.fn(() => ''),
    buildEnhancedPath: vi.fn(() => process.env.PATH || ''),
    getBundledNodeExe: () => '',
  },
}));

vi.mock('node-pty', () => ({ spawn: spawnPty }));

vi.mock('../../../utils/ipc-helpers', () => ({ createSender: vi.fn(() => mockSend) }));

import type { SystemPromptChoice } from '../../../../shared/system-prompt';
import { IPC_CHANNELS } from '../../../../shared/types';
import { createMockBrowserWindow } from '../../../__tests__/setup';
import ClaudeCodeService from '../../ClaudeCodeService';
import ConfigService from '../../ConfigService';

const CONVERSATION = 'conversation-1';
const FRENCH: SystemPromptChoice = { claudeCodePrompt: false, instructions: 'Answer in French.' };

let root: string;
let folder: string;
let configService: ConfigService;
let service: ClaudeCodeService;

const recorded = () => mockSend.mock.calls
  .filter((call) => call[0] === IPC_CHANNELS.CLAUDE_SYSTEM_PROMPT_RECORDED && call[1] === CONVERSATION)
  .map((call) => call[2]);

beforeEach(async () => {
  for (const key of Object.keys(mockStoreData)) delete mockStoreData[key];
  mockSend.mockClear();
  terminals.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-channel-prompt-recorded-'));
  folder = path.join(root, 'plain');
  fs.mkdirSync(folder);
  paths.sessions = path.join(root, 'sessions');

  configService = new ConfigService();
  await configService.ensureInitialized();
  await configService.setOAuthToken('sk-ant-oat01-test-token-that-is-long-enough-to-pass-validation-check');
  await configService.setConfig({ executionMode: 'channel', claudeCodePrompt: 'off', customInstructions: FRENCH.instructions });
  service = new ClaudeCodeService(configService, vi.fn().mockReturnValue(createMockBrowserWindow()) as never, {
    showPermissionRequest: vi.fn(), showTurnEnded: vi.fn(), showTaskEnded: vi.fn(), showError: vi.fn(),
  } as never);
});

afterEach(async () => {
  await service.abortAll();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('what the renderer is told the CLI recorded for a channel discussion', () => {
  it('is the prompt a new discussion starts on', async () => {
    await service.sendMessage(CONVERSATION, 'Hello', folder);

    expect(terminals).toHaveLength(1);
    expect(recorded()).toEqual([FRENCH]);
  });

  it('is nothing for a discussion resumed: the CLI keeps what it recorded', async () => {
    await service.sendMessage(CONVERSATION, 'Hello', folder, 'sdk-1');

    expect(terminals).toHaveLength(1);
    expect(recorded()).toEqual([]);
  });
});
