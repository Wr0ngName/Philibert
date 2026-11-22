/**
 * The projects Settings lists, read through the whole path: the store asks
 * the preload, the real conversation IPC handler, and the real
 * ConversationService reading the discussions on disk. Listed: the folders
 * with a discussion not archived, the working folder first — and it too only
 * while one of its discussions is not archived, or it has none yet. A folder
 * whose discussions are all archived — by hand, by inactivity, or their Claude
 * Code session gone — is not, even made the working one by opening one of
 * them, until one is brought back.
 *
 * Only Electron and the filesystem are faked.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { DAY_MS } from '@shared/conversation-list';
import type { Conversation } from '@shared/types';

vi.mock('node:fs', async () => (await import('./support/real-stack')).fakeFsModule());
vi.mock('electron', async () => (await import('./support/real-stack')).fakeElectronModule());
vi.mock('../../../main/utils/paths', () => ({
  getConversationsPath: () => '/conversations',
  isPathWithin: (target: string, root: string) => target.startsWith(root),
}));
vi.mock('../../../main/utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogLevel: vi.fn(),
}));
vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { setupConversationIPC } from '../../../main/ipc/conversations';
import { ConversationService } from '../../../main/services/ConversationService';
import { cliConfigDir } from '../../../main/services/claude/cliCredentials';
import '../../../preload/preload';
import { useChatStore } from '../chat';
import { useConversationsStore } from '../conversations';
import { useMcpStore } from '../mcp';
import { useSettingsStore } from '../settings';

import { files, sessionOnDisk, settle, startRealStack } from './support/real-stack';

const CURRENT = '/work/current';

/** A discussion in a folder, its session on disk unless said otherwise. */
function seed(id: string, workingDirectory: string, overrides: Partial<Conversation> = {}, sessionKept = true): void {
  const at = overrides.updatedAt ?? Date.now() - 1000;
  const conversation: Conversation = {
    id,
    title: `Discussion ${id}`,
    workingDirectory,
    createdAt: at,
    updatedAt: at,
    messages: [{ id: `${id}-m`, role: 'user', content: 'the question', timestamp: at }],
    sdkSessionId: `session-${id}`,
    ...overrides,
  };
  files.set(`/conversations/${id}.json`, JSON.stringify(conversation));
  if (sessionKept) sessionOnDisk(`session-${id}`);
}

beforeEach(async () => {
  await startRealStack({
    ConversationService: ConversationService as unknown as new () => never,
    setupConversationIPC: setupConversationIPC as unknown as (service: never) => void,
    workingDirectory: CURRENT,
  });
  // Claude Code has run: its projects folder is where sessions are looked for.
  fs.mkdirSync(path.join(cliConfigDir(), 'projects'));
  const settings = useSettingsStore();
  settings.config.workingDirectory = CURRENT;
  settings.config.autoArchiveDays = 30;
});

describe('the projects Settings lists', () => {
  it('leave out the folder of an archived discussion opened, though it becomes the working folder, and take it back once the discussion is brought back', async () => {
    seed('live', '/work/live');
    seed('old', '/work/old', { archivedAt: Date.now() });
    const conversations = useConversationsStore();
    await conversations.loadConversationList();
    const mcp = useMcpStore();
    await settle();

    await conversations.loadConversation('old');
    await settle();
    expect(useSettingsStore().workingDirectory).toBe('/work/old');
    expect(mcp.currentProjectListed).toBe(false);
    expect(mcp.projectChoices).toEqual(['/work/live']);
    expect(mcp.projectDir).toBe('/work/live');

    await conversations.setConversationArchived('old', false);
    await settle();
    expect(mcp.currentProjectListed).toBe(true);
    expect(mcp.projectChoices).toEqual(['/work/old', '/work/live']);
  });

  it('take back the folder of an archived discussion once a new discussion is started there, before it is first saved', async () => {
    seed('old', '/work/old', { archivedAt: Date.now() });
    const conversations = useConversationsStore();
    await conversations.loadConversationList();
    const mcp = useMcpStore();
    await conversations.loadConversation('old');
    await settle();
    expect(mcp.currentProjectListed).toBe(false);

    conversations.createNewConversation();
    await settle();

    expect(files.has('/conversations/' + conversations.currentConversationId + '.json')).toBe(false);
    expect(mcp.currentProjectListed).toBe(true);
    expect(mcp.projectChoices).toEqual(['/work/old']);

    // Its first message saved: on disk now, the folder is listed from there on.
    useChatStore().messages.push({ id: 'first', role: 'user', content: 'a new start', timestamp: Date.now() });
    expect(await conversations.saveCurrentConversation()).toBe(true);
    await settle();
    expect(files.has('/conversations/' + conversations.currentConversationId + '.json')).toBe(true);
    expect(mcp.currentProjectListed).toBe(true);
    expect(mcp.projectChoices).toEqual(['/work/old']);
  });

  it('keep a working folder with no discussion yet, to be set up before the first', async () => {
    seed('live', '/work/live');
    const mcp = useMcpStore();
    await mcp.loadProjects();
    await settle();

    expect(mcp.currentProjectListed).toBe(true);
    expect(mcp.projectChoices).toEqual([CURRENT, '/work/live']);
  });

  it('are the working folder, then those with a discussion not archived — none archived by hand, by inactivity, or with its session gone', async () => {
    const now = Date.now();
    seed('recent', '/work/recent', { updatedAt: now - 1000 });
    seed('older', '/work/older', { updatedAt: now - 5000 });
    seed('by-hand', '/work/by-hand', { updatedAt: now - 2000, archivedAt: now });
    seed('inactive', '/work/inactive', { updatedAt: now - 40 * DAY_MS });
    seed('cleaned', '/work/cleaned', { updatedAt: now - 3000 }, false);

    const mcp = useMcpStore();
    await mcp.loadProjects();
    await settle();

    expect(mcp.projectChoices).toEqual([CURRENT, '/work/recent', '/work/older']);
  });

  it('take a folder back once one of its discussions is brought back from the archive', async () => {
    seed('by-hand', '/work/by-hand', { archivedAt: Date.now() });
    const mcp = useMcpStore();
    await mcp.loadProjects();
    expect(mcp.projectChoices).toEqual([CURRENT]);

    await window.electron.conversation.setArchived('by-hand', false);
    await mcp.loadProjects();
    await settle();

    expect(mcp.projectChoices).toEqual([CURRENT, '/work/by-hand']);
  });
});
