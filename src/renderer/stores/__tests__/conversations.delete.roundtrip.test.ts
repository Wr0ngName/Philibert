/**
 * Deleting a conversation from the list, through the real path.
 *
 * Reported as: the discussion always comes back instantly. Real list
 * component, real stores, real preload, real IPC handlers and the real
 * ConversationService; only Electron and the filesystem are faked.
 */

import { mount } from '@vue/test-utils';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { ChatMessage } from '@shared/types';

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
import ConversationHistory from '../../components/conversations/ConversationHistory.vue';
import { useChatStore } from '../chat';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import {
  startRealStack, settle, onDisk, disk, releaseWrites, emitIpc, mainHandlers, mountApp, unmountApp, send,
} from './support/real-stack';

function message(id: string, content = `content ${id}`): ChatMessage {
  return { id, role: 'user', content, timestamp: Date.now() };
}

describe('deleting a conversation from the list', () => {
  let store: ReturnType<typeof useConversationsStore>;
  let chatStore: ReturnType<typeof useChatStore>;
  let history: ReturnType<typeof mount> | null = null;
  let app: ReturnType<typeof mount> | null = null;

  /** Make a conversation with messages, saved to disk, and leave it open. */
  async function makeConversation(firstMessage: string): Promise<string> {
    store.createNewConversation();
    const id = store.currentConversationId!;
    chatStore.addUserMessage(firstMessage);
    chatStore.messages.push(message(`${id}-a`, 'and more'));
    expect(await store.saveCurrentConversation()).toBe(true);
    await settle();
    return id;
  }

  /** What a fresh start would list: read back from disk, not from memory. */
  async function listedAfterRestart(): Promise<string[]> {
    const listed = await window.electron.conversation.list();
    return listed.map((c) => c.id);
  }

  /** Trash icon, then Delete on the confirmation, as the user does. */
  async function deleteFromList(title: string): Promise<void> {
    const row = history!.findAll('.group').find((r) => r.text().includes(title));
    expect(row, `no row titled "${title}" in the list`).toBeDefined();
    await row!.find('button[title="Delete conversation"]').trigger('click');
    await settle();
    const confirm = history!.findAll('button').find((b) => b.text() === 'Delete');
    expect(confirm, 'no confirm button appeared').toBeDefined();
    await confirm!.trigger('click');
    await vi.waitFor(() => expect(history!.findAll('button').some((b) => b.text() === 'Delete')).toBe(false));
    await settle(20);
  }

  beforeEach(async () => {
    await startRealStack({
      ConversationService: ConversationService as unknown as new () => never,
      setupConversationIPC: setupConversationIPC as unknown as (service: never) => void,
    });
    store = useConversationsStore();
    chatStore = useChatStore();
    const settings = useSettingsStore();
    settings.config.workingDirectory = '/home/user/project';
    settings.config.apiKey = 'test-key';
    await store.loadConversationList();
    await settle();
    app = mountApp(ChatWindow);
    history = mount(ConversationHistory);
    await settle();
  });

  afterEach(() => {
    history?.unmount();
    history = null;
    app = null;
    unmountApp();
  });

  it('deletes the conversation that is open', async () => {
    const other = await makeConversation('the other one');
    const open = await makeConversation('the open one');
    await settle();

    // Deleting the open conversation opens a new one, and opening a new one
    // saves what is on screen first — which was the conversation just
    // deleted, so the write recreated it.
    await deleteFromList('the open one');

    expect(onDisk(open), 'the file came back').toBeNull();
    expect(store.conversations.map((c) => c.id)).not.toContain(open);
    expect(await listedAfterRestart()).not.toContain(open);
    expect(await listedAfterRestart()).toContain(other);
  });

  it('deletes a conversation that is not open', async () => {
    const closed = await makeConversation('the closed one');
    const open = await makeConversation('the open one');
    await settle();

    await deleteFromList('the closed one');

    expect(onDisk(closed), 'the file came back').toBeNull();
    expect(store.conversations.map((c) => c.id)).not.toContain(closed);
    expect(await listedAfterRestart()).not.toContain(closed);
    expect(onDisk(open)).not.toBeNull();
  });

  it('stays deleted when a save of it was already being written', async () => {
    const open = await makeConversation('the open one');
    chatStore.messages.push(message('late'));
    disk.holdWrites = true;
    const inFlight = store.saveCurrentConversation();
    await settle();

    // The write is under way when the user deletes. Removing the file before
    // it lands means it lands on nothing, and creates the file again.
    const deleting = store.deleteConversation(open);
    await settle();
    await releaseWrites();
    await inFlight;
    await deleting;
    await settle(20);

    expect(onDisk(open), 'the file came back').toBeNull();
    expect(store.conversations.map((c) => c.id)).not.toContain(open);
    expect(await listedAfterRestart()).not.toContain(open);
  });

  it('stays deleted when a save of it was still waiting its turn', async () => {
    const closed = await makeConversation('the closed one');
    const open = await makeConversation('the open one');

    // A write for the open conversation holds the queue, and one for the
    // closed conversation waits behind it.
    chatStore.messages.push(message('more'));
    disk.holdWrites = true;
    const first = store.saveCurrentConversation();
    await settle();
    const queued = store.saveConversation(closed, [message('closed-late')]);
    await settle();

    const deleting = store.deleteConversation(closed);
    await settle();
    await releaseWrites();
    await Promise.all([first, queued, deleting]);
    await settle(20);

    expect(onDisk(closed), 'the file came back').toBeNull();
    expect(await listedAfterRestart()).not.toContain(closed);
    // The other conversation's write still went out.
    expect((onDisk(open)?.messages ?? []).map((m) => m.id)).toContain('more');
  });

  it('stops a turn still running in it, and stays deleted when that turn ends', async () => {
    const aborted: string[] = [];
    mainHandlers.set('claude:abort', (_event, id) => {
      aborted.push(id as string);
    });
    mainHandlers.set('claude:send', () => undefined);
    const open = await makeConversation('the busy one');
    await makeConversation('another');
    await store.switchConversation(open);
    await settle();
    await send(app!, 'go on then');
    emitIpc('claude:chunk', open, 'half an ans');
    await settle();
    expect(chatStore.isConversationLoading(open), 'the turn never started').toBe(true);

    await deleteFromList('the busy one');

    expect(aborted).toEqual([open]);
    // What the main process still sends for it, after the delete.
    emitIpc('claude:chunk', open, 'wer');
    emitIpc('claude:done', open);
    await settle(20);

    expect(onDisk(open), 'the file came back').toBeNull();
    expect(store.conversations.map((c) => c.id)).not.toContain(open);
    expect(await listedAfterRestart()).not.toContain(open);
  });

  it('keeps a conversation it failed to delete, and keeps saving it', async () => {
    const aborted: string[] = [];
    mainHandlers.set('claude:abort', (_event, id) => {
      aborted.push(id as string);
    });
    const open = await makeConversation('the stuck one');
    chatStore.setLoading(open, true);
    disk.failUnlink = true;

    await deleteFromList('the stuck one');

    expect(store.error).toBe('Failed to delete conversation');
    // The conversation is staying, so its turn is not the delete's to stop.
    expect(aborted).toEqual([]);
    chatStore.setLoading(open, false);
    expect(onDisk(open)).not.toBeNull();
    expect(store.conversations.map((c) => c.id)).toContain(open);

    // Still the conversation on screen, and still one the user can write in.
    disk.failUnlink = false;
    chatStore.messages.push(message('after'));
    expect(await store.saveCurrentConversation()).toBe(true);
    expect((onDisk(open)?.messages ?? []).map((m) => m.id)).toContain('after');
  });
});
