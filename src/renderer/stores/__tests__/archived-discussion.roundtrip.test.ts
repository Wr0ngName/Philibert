/**
 * An archived discussion, open: nothing can be written in it — no prompt, no
 * send, picture or voice button — until it is brought back from the archive,
 * which is offered where the input was. One whose Claude Code session is gone
 * has nothing left to continue, and is not offered the way back.
 *
 * Real ChatWindow, real stores, real preload, real conversation IPC handlers
 * and the real ConversationService; only Electron and the filesystem are
 * faked.
 */

import type { mount } from '@vue/test-utils';
import type { BrowserWindow } from 'electron';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { DAY_MS, SESSION_GONE_NOTICE } from '@shared/conversation-list';
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

import { setupClaudeSessionsIPC } from '../../../main/ipc/claudeSessions';
import { setupConversationIPC } from '../../../main/ipc/conversations';
import { ConversationService } from '../../../main/services/ConversationService';
import '../../../preload/preload';
import ChatWindow from '../../components/chat/ChatWindow.vue';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import {
  emitIpc, files, mainHandlers, mountApp, removeFileOutside, send, sessionOnDisk, sessionTranscriptPath, settle,
  startRealStack, unmountApp,
} from './support/real-stack';

const DIR = '/home/user/project';

let store: ReturnType<typeof useConversationsStore>;
let app: ReturnType<typeof mount>;

function seed(id: string, overrides: Partial<Conversation> = {}): void {
  const at = Date.now() - 1000;
  const conversation: Conversation = {
    id,
    title: `Discussion ${id}`,
    workingDirectory: DIR,
    createdAt: at,
    updatedAt: at,
    messages: [{ id: `${id}-m`, role: 'user', content: 'the question', timestamp: at }],
    sdkSessionId: `session-${id}`,
    ...overrides,
  };
  files.set(`/conversations/${id}.json`, JSON.stringify(conversation));
}

const input = () => app.find('textarea');
const bar = () => app.find('.archived-discussion-bar');
const bringBack = () => bar().find('button.bring-back');

beforeEach(async () => {
  await startRealStack({
    ConversationService: ConversationService as unknown as new () => never,
    setupConversationIPC: setupConversationIPC as unknown as (service: never) => void,
    workingDirectory: DIR,
  });
  // The real handlers: whether a session is on disk is read from the fake
  // disk, and what they send reaches the renderer as from the main window.
  setupClaudeSessionsIPC(() => ({
    isDestroyed: () => false,
    webContents: { send: (channel: string, ...args: unknown[]) => emitIpc(channel, ...args) },
  }) as unknown as BrowserWindow);
  store = useConversationsStore();
  const settings = useSettingsStore();
  settings.config.workingDirectory = DIR;
  settings.config.apiKey = 'test-key';
  await store.loadConversationList();
  await settle();
  app = mountApp(ChatWindow);
  await settle();
});

afterEach(() => {
  unmountApp();
  document.body.innerHTML = '';
});

describe('an archived discussion, open', () => {
  it('has no input, and offers to bring it back — after which it can be written in', async () => {
    seed('a', { archivedAt: Date.now() });
    sessionOnDisk('session-a');
    await store.loadConversation('a');
    await settle();

    expect(input().exists()).toBe(false);
    expect(bar().text()).toContain('This discussion is archived');
    expect(bringBack().exists()).toBe(true);

    await bringBack().trigger('click');
    await settle(20);

    expect(bar().exists()).toBe(false);
    expect(input().exists()).toBe(true);
    const stored = JSON.parse(files.get('/conversations/a.json')!) as Conversation;
    expect(stored.archivedAt).toBeUndefined();
    expect(stored.restoredAt).toBeTypeOf('number');
  });

  it('is the same for one archived for being inactive', async () => {
    const old = Date.now() - 60 * DAY_MS;
    seed('old', { createdAt: old, updatedAt: old, messages: [{ id: 'old-m', role: 'user', content: 'q', timestamp: old }] });
    sessionOnDisk('session-old');
    useSettingsStore().config.autoArchiveDays = 30;
    await store.loadConversation('old');
    await settle();

    expect(input().exists()).toBe(false);
    expect(bringBack().exists()).toBe(true);
  });

  it('whose Claude session is gone, says so and has no way back', async () => {
    seed('gone', { archivedAt: Date.now() });
    await store.loadConversation('gone');
    await settle();

    expect(input().exists()).toBe(false);
    expect(bar().text()).toContain("Claude's session for it no longer exists");
    expect(bringBack().exists()).toBe(false);
  });

  it('keeps its input when it is not archived', async () => {
    seed('active');
    sessionOnDisk('session-active');
    await store.loadConversation('active');
    await settle();

    expect(bar().exists()).toBe(false);
    expect(input().exists()).toBe(true);
  });
});

describe('a discussion whose Claude session is gone', () => {
  /** What reached the main process's send handler: [conversationId, prompt]. */
  let sends: [string, string][];

  beforeEach(() => {
    sends = [];
    mainHandlers.set('claude:send', (_event, conversationId, prompt) => {
      sends.push([conversationId as string, prompt as string]);
      return null;
    });
  });

  /** Claude Code deleted the session, as it does after its retention period. */
  function sessionCleanedUp(sessionId: string): void {
    for (const key of [...files.keys()]) {
      if (key.endsWith(`/${sessionId}.jsonl`)) files.delete(key);
    }
  }

  it('is archived for good, never in the active list, though nobody archived it', async () => {
    seed('lost');
    seed('fine');
    sessionOnDisk('session-fine');
    await store.loadConversationList();
    await settle();

    expect(store.listedConversations.map((c) => c.id)).toEqual(['fine']);
    expect(store.archivedCount).toBe(1);

    await store.loadConversation('lost');
    await settle();
    expect(input().exists()).toBe(false);
    expect(bar().text()).toContain("Claude's session for it no longer exists");
    expect(bringBack().exists()).toBe(false);
    expect(store.listView).toBe('archived');
  });

  it('refuses a prompt once the session is found gone, and moves to the archive, its history kept', async () => {
    seed('a');
    sessionOnDisk('session-a');
    await store.loadConversation('a');
    await settle();
    expect(input().exists()).toBe(true);

    sessionCleanedUp('session-a');
    await send(app, 'and now?');
    await settle(20);

    expect(sends).toEqual([]);
    expect(input().exists()).toBe(false);
    expect(bar().text()).toContain("Claude's session for it no longer exists");
    expect(app.text()).toContain(SESSION_GONE_NOTICE);
    expect(store.listView).toBe('archived');
    expect(store.archivedCount).toBe(1);
    // Nothing of the refused prompt was written, nothing of the history lost.
    const stored = JSON.parse(files.get('/conversations/a.json')!) as Conversation;
    expect(stored.sdkSessionId).toBe('session-a');
    expect(stored).not.toHaveProperty('sessionGone');
  });

  it('sends when the session is still there', async () => {
    seed('a');
    sessionOnDisk('session-a');
    await store.loadConversation('a');
    await settle();

    await send(app, 'and now?');
    await settle(20);

    expect(sends).toEqual([['a', 'and now?']]);
  });

  it('loses its input the moment Claude Code deletes the session, with nothing sent', async () => {
    seed('a');
    sessionOnDisk('session-a');
    await store.loadConversation('a');
    await settle();
    expect(input().exists()).toBe(true);

    removeFileOutside(sessionTranscriptPath('session-a'));
    await settle(20);

    expect(input().exists()).toBe(false);
    expect(bar().text()).toContain("Claude's session for it no longer exists");
    expect(store.isConversationArchived('a')).toBe(true);
    expect(sends).toEqual([]);
  });

  it('watches the discussion on screen only, and a new one once its first turn wrote its transcript', async () => {
    seed('a');
    sessionOnDisk('session-a');
    seed('b');
    sessionOnDisk('session-b');
    await store.loadConversation('a');
    await settle();
    await store.loadConversation('b');
    await settle();

    // No longer on screen: its session is not watched.
    removeFileOutside(sessionTranscriptPath('session-a'));
    await settle(20);
    expect(store.isConversationArchived('a')).toBe(false);

    // A new discussion: its session id comes before its transcript is written.
    store.createNewConversation();
    const id = store.currentConversationId!;
    await send(app, 'hello');
    emitIpc('claude:session-id', id, 'session-new');
    await settle(20);
    expect(store.isConversationArchived(id)).toBe(false);
    sessionOnDisk('session-new');
    emitIpc('claude:done', id);
    await settle(20);

    removeFileOutside(sessionTranscriptPath('session-new'));
    await settle(20);
    expect(store.isConversationArchived(id)).toBe(true);
  });

  it('is archived when a resume finds it gone', async () => {
    seed('a');
    sessionOnDisk('session-a');
    await store.loadConversation('a');
    await settle();

    emitIpc('claude:session-gone', 'a');
    await settle(20);

    expect(input().exists()).toBe(false);
    expect(store.isConversationArchived('a')).toBe(true);
    expect(bringBack().exists()).toBe(false);
  });
});
