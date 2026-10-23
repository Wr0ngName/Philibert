/**
 * Tests for the project permission IPC handlers, run against the real
 * ProjectPermissionService and a temp project directory.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockIpcMain } = vi.hoisted(() => ({
  mockIpcMain: { handle: vi.fn() },
}));

vi.mock('electron', () => ({ ipcMain: mockIpcMain }));

vi.mock('../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { IPC_CHANNELS } from '../../../shared/types';
import { ValidationError } from '../../errors';
import { ProjectPermissionService } from '../../services/ProjectPermissionService';
import { setupProjectPermissionsIPC } from '../projectPermissions';

let projectDir: string;
let handlers: Map<string, (...args: unknown[]) => Promise<unknown>>;

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({}, ...args);
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-project-perms-ipc-'));
  fs.mkdirSync(path.join(projectDir, '.claude'));
  fs.writeFileSync(
    path.join(projectDir, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { allow: ['Write'] } })
  );

  handlers = new Map();
  mockIpcMain.handle.mockImplementation((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
    handlers.set(channel, handler);
  });
  setupProjectPermissionsIPC(new ProjectPermissionService());
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe('project permissions IPC', () => {
  it('lists the entries of the given working directory', async () => {
    await expect(invoke(IPC_CHANNELS.CLAUDE_GET_PROJECT_PERMISSIONS, projectDir)).resolves.toEqual([
      { kind: 'rule', value: 'Write', toolName: 'Write', source: 'local' },
    ]);
  });

  it('revokes and returns the updated list', async () => {
    await expect(
      invoke(IPC_CHANNELS.CLAUDE_REVOKE_PROJECT_PERMISSION, projectDir, 'rule', 'Write')
    ).resolves.toEqual([]);
  });

  it('rejects an unknown entry kind without touching the file', async () => {
    await expect(
      invoke(IPC_CHANNELS.CLAUDE_REVOKE_PROJECT_PERMISSION, projectDir, 'mode', 'Write')
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(invoke(IPC_CHANNELS.CLAUDE_GET_PROJECT_PERMISSIONS, projectDir)).resolves.toHaveLength(1);
  });

  it('rejects a working directory with path traversal', async () => {
    await expect(
      invoke(IPC_CHANNELS.CLAUDE_GET_PROJECT_PERMISSIONS, `${projectDir}/../elsewhere`)
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a missing working directory', async () => {
    await expect(invoke(IPC_CHANNELS.CLAUDE_GET_PROJECT_PERMISSIONS, undefined)).rejects.toBeInstanceOf(ValidationError);
  });
});
