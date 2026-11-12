/**
 * The IPC handlers for the tools every project has — claude.ai connectors and
 * user-wide servers — through the real services, against real files: Claude
 * Code's user settings and global config file in a scratch config folder.
 *
 * Only the process boundaries are faked: Electron, electron-store, the SDK's
 * sessions (shaped as CLI 2.1.280 answers), and the `claude` command run.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { handlers, mockQuery, mockOpenExternal, storeData } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  mockQuery: vi.fn(),
  mockOpenExternal: vi.fn(),
  storeData: {} as Record<string, unknown>,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
    on: vi.fn(),
  },
  shell: { openExternal: mockOpenExternal },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  BrowserWindow: vi.fn(),
  Notification: Object.assign(vi.fn(), { isSupported: () => false }),
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (buffer: Buffer) => buffer.toString().slice('encrypted:'.length),
  },
  app: {
    getPath: () => path.join(os.tmpdir(), 'philibert-mcp-ipc-userdata'),
    getAppPath: () => path.join(os.tmpdir(), 'philibert-mcp-ipc-app'),
    isPackaged: false,
  },
}));

vi.mock('electron-store', () => ({
  default: class MockStore {
    constructor(opts?: { defaults?: Record<string, unknown> }) {
      Object.assign(storeData, opts?.defaults || {});
    }
    get(key: string, defaultValue?: unknown) { return key in storeData ? storeData[key] : defaultValue; }
    set(key: string, value: unknown) { storeData[key] = value; }
    delete(key: string) { delete storeData[key]; }
    clear() { for (const k of Object.keys(storeData)) delete storeData[k]; }
    get store() { return { ...storeData }; }
  },
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery, getSubagentMessages: vi.fn() }));

vi.mock('../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogLevel: vi.fn(),
}));

import { IPC_CHANNELS } from '../../../shared/types';
import ClaudeCodeService from '../../services/ClaudeCodeService';
import ConfigService from '../../services/ConfigService';
import { McpConfigService } from '../../services/McpConfigService';
import NotificationService from '../../services/NotificationService';
import { setupMcpIPC } from '../mcp';

const PROJECT = path.join(os.tmpdir(), 'philibert-mcp-ipc-project');

let configDir: string;
let savedConfigDir: string | undefined;

/** A session that runs nothing, whose server list is `servers`. */
function session(servers: unknown[], extra: Record<string, unknown> = {}) {
  return {
    [Symbol.asyncIterator]: async function* () { /* no turn ever runs */ },
    mcpServerStatus: vi.fn(async () => servers),
    ...extra,
  };
}
const gmail = (status: string) => ({ name: 'claude.ai Gmail', status, scope: 'claudeai', source: 'claudeai' });
const notes = (status: string) => ({ name: 'notes', status, scope: 'user', source: 'user' });

function call(channel: string, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve(handlers.get(channel)!({}, ...args));
}

function writeSettings(value: unknown): void {
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(value));
}

beforeEach(async () => {
  vi.clearAllMocks();
  handlers.clear();
  for (const k of Object.keys(storeData)) delete storeData[k];
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-mcp-ipc-'));
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({
    mcpServers: { notes: { type: 'stdio', command: process.execPath } },
  }));

  const configService = new ConfigService();
  await configService.ensureInitialized();
  await configService.setOAuthToken('sk-ant-oat01-test-token-that-is-long-enough-to-pass-validation-check');
  const notifications = new NotificationService(configService, () => null);
  const claudeService = new ClaudeCodeService(configService, () => null, notifications);
  const mcpService = new McpConfigService(async () => ({ ok: true, stderr: '' }));
  setupMcpIPC(mcpService, claudeService, () => null);
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('the tools every project has', () => {
  it('reads them in a folder of the app, with the user-wide servers and what is off everywhere', async () => {
    writeSettings({ deniedMcpServers: [{ serverName: 'claude.ai Drive' }, { serverUrl: 'https://x/*' }] });
    mockQuery.mockReturnValue(session([gmail('needs-auth'), notes('connected')]));

    expect(await call(IPC_CHANNELS.MCP_GLOBAL_TOOLS)).toEqual({
      statuses: [
        { name: 'claude.ai Gmail', kind: 'connector', status: 'needs-auth' },
        { name: 'notes', kind: 'user', status: 'connected' },
      ],
      userServers: [expect.objectContaining({ name: 'notes', enabled: true })],
      offEverywhere: ['claude.ai Drive'],
    });
    expect(mockQuery.mock.calls[0]![0].options.cwd).toBe(path.join(os.tmpdir(), 'philibert-mcp-ipc-userdata', 'tools-check'));
  });

  it("turns one off everywhere in Claude Code's user settings, keeping the rest, and answers with them as they now stand", async () => {
    writeSettings({ cleanupPeriodDays: 60 });
    mockQuery.mockReturnValue(session([gmail('needs-auth'), notes('connected')]));

    const tools = await call(IPC_CHANNELS.MCP_SET_OFF_EVERYWHERE, 'notes', true) as { userServers: { enabled: boolean }[]; offEverywhere: string[] };

    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf-8')))
      .toEqual({ cleanupPeriodDays: 60, deniedMcpServers: [{ serverName: 'notes' }] });
    expect(tools.offEverywhere).toEqual(['notes']);
    expect(tools.userServers[0]!.enabled).toBe(false);
  });

  it('refuses a tool with no name', async () => {
    await expect(call(IPC_CHANNELS.MCP_SET_OFF_EVERYWHERE, '', true)).rejects.toThrow();
    expect(fs.existsSync(path.join(configDir, 'settings.json'))).toBe(false);
  });

  it('opens the claude.ai page that authorises a connector, and nothing else', async () => {
    mockQuery.mockReturnValue(session([gmail('needs-auth')], {
      mcpAuthenticate: vi.fn().mockResolvedValue({ authUrl: 'https://claude.ai/api/organizations/o/mcp/start-auth/s' }),
    }));

    await call(IPC_CHANNELS.MCP_CONNECTOR_AUTHORIZE, 'claude.ai Gmail');

    expect(mockOpenExternal).toHaveBeenCalledWith('https://claude.ai/api/organizations/o/mcp/start-auth/s');
  });
});

describe('the tools as one project has them', () => {
  it('reads them in the project, with what is off everywhere', async () => {
    writeSettings({ deniedMcpServers: [{ serverName: 'claude.ai Drive' }] });
    mockQuery.mockReturnValue(session([gmail('connected'), notes('disabled')]));

    expect(await call(IPC_CHANNELS.MCP_PROJECT_TOOLS, PROJECT)).toEqual({
      statuses: [
        { name: 'claude.ai Gmail', kind: 'connector', status: 'connected' },
        { name: 'notes', kind: 'user', status: 'disabled' },
      ],
      userServers: ['notes'],
      offEverywhere: ['claude.ai Drive'],
    });
    expect(mockQuery.mock.calls[0]![0].options.cwd).toBe(PROJECT);
  });

  it('turns one off in the project and answers with what the toggle left, without a second session', async () => {
    const toggleMcpServer = vi.fn().mockResolvedValue(undefined);
    let toggled = false;
    mockQuery.mockReturnValue({
      ...session([]),
      mcpServerStatus: vi.fn(async () => [gmail('connected'), notes(toggled ? 'disabled' : 'connected')]),
      toggleMcpServer: vi.fn(async (...args: unknown[]) => { toggled = true; return toggleMcpServer(...args); }),
    });

    const tools = await call(IPC_CHANNELS.MCP_SET_ENABLED_IN_PROJECT, PROJECT, 'notes', false) as { statuses: unknown[] };

    expect(toggleMcpServer).toHaveBeenCalledWith('notes', false);
    expect(tools.statuses).toContainEqual({ name: 'notes', kind: 'user', status: 'disabled' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('refuses a project path that climbs out of itself, and a tool with no name', async () => {
    await expect(call(IPC_CHANNELS.MCP_PROJECT_TOOLS, `${PROJECT}/../elsewhere`)).rejects.toThrow('path traversal');
    await expect(call(IPC_CHANNELS.MCP_SET_ENABLED_IN_PROJECT, PROJECT, '', false)).rejects.toThrow();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
