/**
 * Saves must not be dropped.
 *
 * Reported as messages disappearing, "like if they are not persisted". They
 * were not: a save requested while another was in flight returned straight
 * away and did nothing, and nothing ever retried it. The payload is
 * snapshotted synchronously, so the save already running carries the messages
 * as they were when IT started and can never include anything newer — drop
 * the second request and everything since that snapshot exists only in
 * memory, until a conversation switch replaces the list or the window closes.
 *
 * Saves run at the end of every turn and immediately before a switch, so "a
 * save is already in flight" is the normal state at exactly the moment the
 * list is about to be replaced.
 *
 * Every assertion here is about what reached the disk, through the real store,
 * the real preload and the real main-process ConversationService. It used to
 * assert against a hand-written fake of `window.electron.conversation`, which
 * could only confirm that the store called the function the test had written
 * — never that a message was stored. The disk is slow on demand
 * (`disk.holdWrites`) because an instant write cannot overlap, and overlapping
 * is the whole subject.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { ChatMessage } from '@shared/types';

vi.mock('node:fs', async () => (await import('./support/real-stack')).fakeFsModule());
vi.mock('electron', async () => (await import('./support/real-stack')).fakeElectronModule());
vi.mock('../../../main/utils/paths', () => ({
  getConversationsPath: () => '/conversations',
  isPathWithin: () => true,
}));
vi.mock('../../../main/utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogLevel: vi.fn(),
}));
vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ConversationService } from '../../../main/services/ConversationService';
import '../../../preload/preload';
import { useChatStore } from '../chat';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import {
  startRealStack, settle, onDisk, disk, releaseWrites, unmountApp,
} from './support/real-stack';

const CONV = 'conv-save-queue';

function message(id: string): ChatMessage {
  return { id, role: 'user', content: `content ${id}`, timestamp: Date.now() };
}

/** Message ids as they stand on disk. */
function storedIds(id = CONV): string[] {
  return (onDisk(id)?.messages ?? []).map((m) => m.id);
}

describe('concurrent saves', () => {
  let store: ReturnType<typeof useConversationsStore>;
  let chatStore: ReturnType<typeof useChatStore>;

  beforeEach(async () => {
    await startRealStack({
      ConversationService: ConversationService as unknown as new () => never,
    });

    store = useConversationsStore();
    chatStore = useChatStore();
    const settings = useSettingsStore();
    settings.config.workingDirectory = '/home/user/project';
    settings.config.apiKey = 'test-key';

    await store.loadConversationList();
    await settle();

    store.currentConversationId = CONV;
    chatStore.setCurrentConversation(CONV);
  });

  afterEach(() => {
    unmountApp();
  });

  it('persists messages added while an earlier save was in flight', async () => {
    disk.holdWrites = true;

    chatStore.messages.push(message('m1'));
    const first = store.saveCurrentConversation();
    await settle();

    // Arrives while the first write is still hanging. The snapshot already in
    // flight cannot contain it — it was cloned before this existed.
    chatStore.messages.push(message('m2'));
    const second = store.saveCurrentConversation();

    await releaseWrites();
    expect(await first).toBe(true);
    expect(await second).toBe(true);

    // The defect: the second request returned false without writing, so m2
    // was never persisted by anything.
    expect(storedIds()).toContain('m2');
  });

  it('persists the newest state, not a stale snapshot', async () => {
    disk.holdWrites = true;

    chatStore.messages.push(message('m1'));
    const first = store.saveCurrentConversation();
    await settle();

    chatStore.messages.push(message('m2'));
    chatStore.messages.push(message('m3'));
    const second = store.saveCurrentConversation();

    await releaseWrites();
    await first;
    await second;

    // Whatever the last write was, the file must describe the conversation as
    // it actually stands. A save that persists a prefix is the data loss.
    expect(storedIds()).toEqual(['m1', 'm2', 'm3']);
  });

  it('coalesces a burst of requests rather than writing once per request', async () => {
    // Turn end, autosave and a switch can all ask within the same tick. They
    // must not each cost a write — one covering the final state is both
    // correct and what the old "already saving" guard was reaching for.
    disk.holdWrites = true;

    chatStore.messages.push(message('m1'));
    const first = store.saveCurrentConversation();
    await settle();

    chatStore.messages.push(message('m2'));
    const burst = [
      store.saveCurrentConversation(),
      store.saveCurrentConversation(),
      store.saveCurrentConversation(),
    ];

    await releaseWrites();
    await first;
    await Promise.all(burst);

    // One write for the snapshot in flight, one covering the burst.
    expect(disk.writes).toBe(2);
    expect(storedIds()).toEqual(['m1', 'm2']);
  });

  it('does not resolve a queued save before it has been written', async () => {
    // `switchConversation` awaits the save and then replaces the message
    // list. If the promise resolves early, the switch discards messages
    // before they reach disk — which is the loss this is all about.
    disk.holdWrites = true;

    chatStore.messages.push(message('m1'));
    const first = store.saveCurrentConversation();
    await settle();

    chatStore.messages.push(message('m2'));
    let secondSettled = false;
    const second = store.saveCurrentConversation().then((result) => {
      secondSettled = true;
      return result;
    });
    await settle();

    expect(secondSettled).toBe(false);
    expect(storedIds()).toEqual([]);

    await releaseWrites();
    await second;
    await first;

    expect(secondSettled).toBe(true);
    expect(storedIds()).toEqual(['m1', 'm2']);
  });

  it('keeps saving after one save fails', async () => {
    // A failed write must not leave the queue wedged, or every later save is
    // silently dropped for the rest of the session.
    disk.failNext = 3; // the service retries three times before giving up

    chatStore.messages.push(message('m1'));
    expect(await store.saveCurrentConversation()).toBe(false);

    chatStore.messages.push(message('m2'));
    expect(await store.saveCurrentConversation()).toBe(true);

    expect(storedIds()).toEqual(['m1', 'm2']);
  });

  it('still refuses to save with nothing to save', async () => {
    expect(await store.saveCurrentConversation()).toBe(false);
    expect(disk.writes).toBe(0);
  });

  it('does not shorten a stored conversation when memory holds less of it', async () => {
    // The property the window depends on: a write carries what the renderer
    // has, and the renderer may have only the tail. Before writes became
    // upserts this stored exactly what was passed, which is why trimming
    // memory would have erased history.
    await store.saveConversation(CONV, [message('m1'), message('m2'), message('m3')]);
    await settle();
    expect(storedIds()).toEqual(['m1', 'm2', 'm3']);

    await store.saveConversation(CONV, [message('m4')]);
    await settle();

    expect(storedIds()).toEqual(['m1', 'm2', 'm3', 'm4']);
  });
});

describe('closing the app with a turn running out of sight', () => {
  let store: ReturnType<typeof useConversationsStore>;
  let chatStore: ReturnType<typeof useChatStore>;

  beforeEach(async () => {
    await startRealStack({
      ConversationService: ConversationService as unknown as new () => never,
    });
    store = useConversationsStore();
    chatStore = useChatStore();
    const settings = useSettingsStore();
    settings.config.workingDirectory = '/home/user/project';
    settings.config.apiKey = 'test-key';
    await store.loadConversationList();
    await settle();
  });

  afterEach(() => {
    unmountApp();
  });

  /** A turn running in another conversation while the user looks at CONV. */
  function backgroundTurnElsewhere(): void {
    chatStore.setCurrentConversation('conv-background');
    chatStore.messages.push(message('bg1'));
    chatStore.beginMessageBuffer('conv-background');
    chatStore.setCurrentConversation(CONV);
    chatStore.loadMessages([message('seen1')]);
    store.currentConversationId = CONV;
    // More of the background turn, after the switch.
    chatStore.startAssistantMessage('conv-background');
  }

  it('writes the background turn as well as the one on screen', async () => {
    // Only the conversation on screen used to be saved here, so a turn
    // running elsewhere lost everything since its last save: its buffer is
    // written when the turn ends, and closing the app means that never
    // happens.
    backgroundTurnElsewhere();

    await store.cleanup();
    await settle();

    expect(storedIds(CONV)).toEqual(['seen1']);
    expect(storedIds('conv-background')).toHaveLength(2);
  });

  it('does not write the conversation on screen twice', async () => {
    backgroundTurnElsewhere();

    await store.cleanup();
    await settle();

    // Two conversations, one write each.
    expect(disk.writes).toBe(2);
  });

  it('writes nothing for a conversation whose buffer is empty', async () => {
    chatStore.setCurrentConversation(CONV);
    chatStore.messages.push(message('seen1'));
    store.currentConversationId = CONV;
    chatStore.beginMessageBuffer('conv-empty');

    await store.cleanup();
    await settle();

    expect(onDisk('conv-empty')).toBeNull();
    expect(storedIds(CONV)).toEqual(['seen1']);
  });

  it('saves the remaining conversations when one of them fails', async () => {
    backgroundTurnElsewhere();
    chatStore.setCurrentConversation('conv-second-bg');
    chatStore.messages.push(message('bg2'));
    chatStore.beginMessageBuffer('conv-second-bg');
    chatStore.setCurrentConversation(CONV);
    chatStore.loadMessages([message('seen1')]);

    // The first write fails all its retries; the rest must still happen.
    disk.failNext = 3;

    await store.cleanup();
    await settle();

    const stored = ['conv-background', 'conv-second-bg', CONV]
      .filter((id) => onDisk(id) !== null);
    expect(stored.length).toBeGreaterThanOrEqual(2);
  });
});
