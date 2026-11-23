/**
 * The system prompt a discussion's session starts with (@shared/system-prompt):
 * read from the settings and from git about the discussion's folder, then
 * handed to the SDK. What the CLI makes of each option is pinned against the
 * real CLI in claude/__tests__/system-prompt-options.cli.test.ts.
 *
 * Real: ConfigService, GitService running git in temporary folders, and the
 * service under test. Mocked, as external boundaries: the SDK's query,
 * electron, electron-store, and `fs` for the CLI's temp root.
 */

import { execFile } from 'node:child_process';
import * as realFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery, mockStoreData } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockStoreData: {} as Record<string, unknown>,
}));

vi.mock('electron', () => ({
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

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery, getSubagentMessages: vi.fn() }));

vi.mock('../../utils/resourcePaths', () => ({
  ClaudeCliPaths: { findBundledCli: vi.fn(() => null) },
  WindowsPaths: {
    hasBundledGit: () => false,
    getGitExe: () => 'git',
    hasBundledGitBash: vi.fn(() => false),
    getBashExe: vi.fn(() => ''),
    buildEnhancedPath: vi.fn(() => process.env.PATH || ''),
  },
}));

vi.mock('../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogLevel: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('../../utils/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/paths')>()),
  getUserDataPath: () => '/user-data',
}));

vi.mock('../../utils/ipc-helpers', () => ({ createSender: vi.fn(() => vi.fn()) }));

import { createMockBrowserWindow } from '../../__tests__/setup';
import ClaudeCodeService from '../ClaudeCodeService';
import ConfigService from '../ConfigService';

import { REAL_DISK_TEST_TIMEOUT_MS } from './support/real-disk';

// Real git, in temporary folders: given the machine's time (see real-disk).
vi.setConfig({ testTimeout: REAL_DISK_TEST_TIMEOUT_MS });

const execFileAsync = promisify(execFile);

let root: string;
let repository: string;
let plain: string;
let configService: ConfigService;
let service: ClaudeCodeService;

/** A session that ends at once: only how it was started is looked at. */
function endingSession() {
  return {
    async *[Symbol.asyncIterator]() { /* no message */ },
    interrupt: vi.fn(),
    supportedCommands: vi.fn().mockResolvedValue([]),
    supportedModels: vi.fn().mockResolvedValue([]),
    setModel: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

/** The `systemPrompt` option a first message in the folder started its session with. */
async function systemPromptIn(folder: string): Promise<unknown> {
  mockQuery.mockClear();
  await service.sendMessage(`conversation-${path.basename(folder)}`, 'Hello', folder);
  expect(mockQuery).toHaveBeenCalledTimes(1);
  const { options } = mockQuery.mock.calls[0]![0];
  return 'systemPrompt' in options ? options.systemPrompt : 'left out';
}

beforeEach(async () => {
  for (const key of Object.keys(mockStoreData)) delete mockStoreData[key];
  mockQuery.mockImplementation(() => endingSession());

  root = realFs.mkdtempSync(path.join(os.tmpdir(), 'philibert-system-prompt-'));
  repository = path.join(root, 'repository');
  plain = path.join(root, 'plain');
  realFs.mkdirSync(repository);
  realFs.mkdirSync(plain);
  await execFileAsync('git', ['init', '--quiet'], { cwd: repository });

  configService = new ConfigService();
  await configService.ensureInitialized();
  await configService.setOAuthToken('sk-ant-oat01-test-token-that-is-long-enough-to-pass-validation-check');
  service = new ClaudeCodeService(configService, vi.fn().mockReturnValue(createMockBrowserWindow()) as never, {
    showPermissionRequest: vi.fn(), showTurnEnded: vi.fn(), showTaskEnded: vi.fn(), showError: vi.fn(),
  } as never);
});

afterEach(async () => {
  await service.abortAll();
  realFs.rmSync(root, { recursive: true, force: true });
});

describe('a discussion starts', () => {
  it("by default, on Claude Code's system prompt in a git repository, and on none elsewhere", async () => {
    expect(await systemPromptIn(repository)).toEqual({ type: 'preset', preset: 'claude_code' });
    expect(await systemPromptIn(plain)).toBe('left out');
  });

  it("on Claude Code's prompt everywhere when always, then the instructions", async () => {
    await configService.setConfig({ claudeCodePrompt: 'on', customInstructions: 'Answer in French.' });

    expect(await systemPromptIn(plain)).toEqual({ type: 'preset', preset: 'claude_code', append: 'Answer in French.' });
  });

  it('on the instructions alone when never', async () => {
    await configService.setConfig({ claudeCodePrompt: 'off', customInstructions: 'Answer in French.' });

    expect(await systemPromptIn(repository)).toBe('Answer in French.');
  });

  it("as its project says, over the general setting, the project's instructions after the general ones", async () => {
    await configService.setConfig({
      claudeCodePrompt: 'auto',
      customInstructions: 'Answer in French.',
      projectSystemPrompts: {
        [repository]: { claudeCodePrompt: 'off', instructions: 'Commit messages on one line.' },
        [plain]: { claudeCodePrompt: 'on' },
      },
    });

    expect(await systemPromptIn(repository)).toBe('Answer in French.\n\nCommit messages on one line.');
    expect(await systemPromptIn(plain)).toEqual({ type: 'preset', preset: 'claude_code', append: 'Answer in French.' });
  });
});
