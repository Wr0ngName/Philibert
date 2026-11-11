/**
 * Each discussion keeps its own model: the one picked in a discussion is what
 * its messages are sent with, and picking another in a different discussion
 * changes nothing here — reported: changing the model in one discussion
 * switched another, ongoing one at its next message.
 *
 * Real ChatWindow, real stores, real preload, real conversation IPC handlers
 * and the real ConversationService; only Electron and the filesystem are
 * faked.
 */

import type { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
import '../../../preload/preload';
import ChatWindow from '../../components/chat/ChatWindow.vue';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import {
  emitIpc, files, mainHandlers, mountApp, onDisk, send, sessionOnDisk, settle, startRealStack, unmountApp,
} from './support/real-stack';

const DIR = '/home/user/project';
const HAIKU = 'claude-haiku-4-5-20251001';
const OPUS = 'claude-opus-4-7';

let store: ReturnType<typeof useConversationsStore>;
let settings: ReturnType<typeof useSettingsStore>;
let app: ReturnType<typeof mount>;
/** What reached the main process's send handler: [conversationId, prompt, model]. */
let sends: [string, string, unknown][];

beforeEach(async () => {
  await startRealStack({
    ConversationService: ConversationService as unknown as new () => never,
    setupConversationIPC: setupConversationIPC as unknown as (service: never) => void,
    workingDirectory: DIR,
  });
  sends = [];
  mainHandlers.set('claude:send', (_event, conversationId, prompt, _cwd, _resume, _images, model) => {
    sends.push([conversationId as string, prompt as string, model]);
    return null;
  });
  mainHandlers.set('claude:session-exists', () => true);
  store = useConversationsStore();
  settings = useSettingsStore();
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

/** A turn in the discussion on screen, answered as Claude Code does. */
async function turn(prompt: string): Promise<string> {
  const id = store.currentConversationId!;
  await send(app, prompt);
  sessionOnDisk(`session-${id}`);
  emitIpc('claude:session-id', id, `session-${id}`);
  emitIpc('claude:chunk', id, `answer to ${prompt}`);
  emitIpc('claude:done', id);
  await settle(20);
  return id;
}

describe("a discussion's model", () => {
  it('is not changed by a model picked in another discussion', async () => {
    await store.setCurrentModel(HAIKU);
    store.createNewConversation();
    const a = await turn('in a');

    store.createNewConversation();
    const b = await turn('in b');
    await store.setCurrentModel(OPUS);

    await store.switchConversation(a);
    await settle(20);
    await turn('a again');

    expect(sends).toEqual([
      [a, 'in a', HAIKU],
      [b, 'in b', HAIKU],
      [a, 'a again', HAIKU],
    ]);
    expect(store.currentModel).toBe(HAIKU);
    // What the next new discussion starts on: the last model picked.
    expect(settings.selectedModel).toBe(OPUS);
  });

  it('is saved with the discussion, and kept after a restart', async () => {
    await store.setCurrentModel(OPUS);
    store.createNewConversation();
    const id = await turn('hello');
    await store.setCurrentModel(HAIKU);
    await settle(20);

    expect(onDisk(id)?.model).toBe(HAIKU);
    store.createNewConversation();
    await store.setCurrentModel(OPUS);
    await settle();

    // A restart: fresh stores, nothing held — read from disk.
    unmountApp();
    setActivePinia(createPinia());
    const fresh = useConversationsStore();
    useSettingsStore().config.workingDirectory = DIR;
    await fresh.loadConversationList();
    await fresh.loadConversation(id);
    await settle(20);

    expect(fresh.currentModel).toBe(HAIKU);
    expect(fresh.modelOf(id)).toBe(HAIKU);
  });

  it('is given to one saved before discussions had their own, once, when it is opened', async () => {
    const at = Date.now() - 1000;
    const legacy: Conversation = {
      id: 'legacy', title: 'Old', workingDirectory: DIR, createdAt: at, updatedAt: at, sdkSessionId: 'session-legacy',
      messages: [
        { id: 'q', role: 'user', content: 'q', timestamp: at },
        { id: 'a', role: 'assistant', content: 'a', timestamp: at },
      ],
    };
    files.set('/conversations/legacy.json', JSON.stringify(legacy));
    sessionOnDisk('session-legacy');
    await settings.setSelectedModel(HAIKU);
    await store.loadConversation('legacy');
    await settle();

    // Picked elsewhere afterwards: the old one keeps what it was given.
    store.createNewConversation();
    await store.setCurrentModel(OPUS);
    await store.switchConversation('legacy');
    await settle(20);

    expect(store.currentModel).toBe(HAIKU);
    await turn('still there?');
    expect(sends.at(-1)).toEqual(['legacy', 'still there?', HAIKU]);
    expect(onDisk('legacy')?.model).toBe(HAIKU);
  });
});
