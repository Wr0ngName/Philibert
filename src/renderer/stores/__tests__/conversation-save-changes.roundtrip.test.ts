/**
 * A save carries only the messages that are not on disk as they are.
 *
 * Asked for: a save sent every message the window holds — 500 to 1,500, about
 * 2 MB on a long discussion — deep-copied in the renderer and again across
 * IPC, for the main process to find nearly all of them unchanged.
 *
 * Through the real store, the real preload and the real ConversationService;
 * what a save carries is read where it arrives, at the service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { ChatMessage, Conversation, ConversationUpdate } from '@shared/types';

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

// Imported after the mocks; importing the preload is what exposes the API.
import { ConversationService } from '../../../main/services/ConversationService';
import '../../../preload/preload';
import { useChatStore } from '../chat';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import { disk, diskContents, files, settle, startRealStack } from './support/real-stack';

const DIR = '/home/user/project';

let store: ReturnType<typeof useConversationsStore>;
let chat: ReturnType<typeof useChatStore>;
/** What each save carried, as the service received it. */
let saves: ConversationUpdate[];

function seed(id: string, contents: string[]): void {
  const conversation: Conversation = {
    id, title: contents[0], workingDirectory: DIR, createdAt: 1000, updatedAt: 2000,
    messages: contents.map((content, i): ChatMessage => ({ id: `${id}-${i}`, role: 'user', content, timestamp: 1000 + i })),
  };
  files.set(`/conversations/${id}.json`, JSON.stringify(conversation));
}

const carried = (save: ConversationUpdate | undefined) => (save?.upsert ?? []).map((m) => m.content);

beforeEach(async () => {
  await startRealStack({ ConversationService: ConversationService as unknown as new () => never, workingDirectory: DIR });
  store = useConversationsStore();
  chat = useChatStore();
  const settings = useSettingsStore();
  settings.config.workingDirectory = DIR;
  settings.config.autoArchiveDays = 0;
  saves = [];
  const update = ConversationService.prototype.update;
  vi.spyOn(ConversationService.prototype, 'update').mockImplementation(function (this: ConversationService, u) {
    saves.push(structuredClone(u));
    return update.call(this, u);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what a save carries', () => {
  it('is only what changed since the last save landed', async () => {
    await store.initialize();
    const id = store.currentConversationId!;
    chat.setCurrentConversation(id);
    chat.addUserMessage('first question');
    chat.startAssistantMessage(id);
    chat.appendChunk(id, 'first answer');
    chat.finishStreaming(id);
    await store.saveCurrentConversation();

    chat.addUserMessage('second question');
    await store.saveCurrentConversation();

    expect(carried(saves[0])).toEqual(['first question', 'first answer']);
    expect(carried(saves[1])).toEqual(['second question']);
    expect(diskContents(id)).toEqual(['first question', 'first answer', 'second question']);
  });

  it('carries a message again once it changes, as a streaming answer does', async () => {
    await store.initialize();
    const id = store.currentConversationId!;
    chat.setCurrentConversation(id);
    chat.addUserMessage('a question');
    chat.startAssistantMessage(id);
    chat.appendChunk(id, 'the start');
    await store.saveCurrentConversation();

    chat.appendChunk(id, ' and the rest');
    chat.finishStreaming(id);
    await store.saveCurrentConversation();

    expect(carried(saves[1])).toEqual(['the start and the rest']);
    expect(diskContents(id)).toEqual(['a question', 'the start and the rest']);
  });

  it('is only the new message after a discussion is opened: what was read is on disk', async () => {
    seed('conv-long', ['one', 'two', 'three']);
    await store.loadConversationList();
    await store.loadConversation('conv-long');

    chat.addUserMessage('four');
    await store.saveCurrentConversation();

    expect(carried(saves[0])).toEqual(['four']);
    expect(diskContents('conv-long')).toEqual(['one', 'two', 'three', 'four']);
  });

  it('is the whole window when it carries a rewind, which removes from the file', async () => {
    seed('conv-r', ['kept', 'rewound']);
    await store.loadConversationList();
    await store.loadConversation('conv-r');
    chat.messages[1].turnUuid = 'turn-to-rewind';

    chat.truncateAfterUserTurn('conv-r', 'turn-to-rewind');
    chat.addUserMessage('asked again');
    await store.saveCurrentConversation();

    expect(saves[0].truncateFromId).toBe('conv-r-1');
    expect(carried(saves[0])).toEqual(['kept', 'asked again']);
    expect(diskContents('conv-r')).toEqual(['kept', 'asked again']);
  });

  it('does not take for stored what a read found before a rewind removed it', async () => {
    // A read answering after a rewind landed holds messages the rewind cut
    // from the file. Taken for stored, they would never be sent again: shown
    // on screen, absent from disk, gone at the next opening.
    seed('conv-race', ['kept', 'rewound', 'after']);
    await store.loadConversationList();
    await store.loadConversation('conv-race');
    chat.messages[1].turnUuid = 'turn-to-rewind';
    let answer: () => void = () => {};
    const answered = new Promise<void>((resolve) => { answer = resolve; });
    const getWindow = ConversationService.prototype.getWindow;
    vi.spyOn(ConversationService.prototype, 'getWindow').mockImplementationOnce(async function (this: ConversationService, ...args) {
      const read = await getWindow.apply(this, args); // the file as it is now, before the rewind
      await answered;
      return read;
    });
    const reading = store.readWindow('conv-race');
    await settle();

    chat.truncateAfterUserTurn('conv-race', 'turn-to-rewind');
    await store.saveCurrentConversation();
    expect(diskContents('conv-race')).toEqual(['kept']);
    answer();
    const stale = await reading;

    // The stale messages come back on screen, as a late page would put them.
    chat.loadMessages(stale!.conversation.messages);
    await store.saveCurrentConversation();

    expect(diskContents('conv-race')).toEqual(chat.messages.map((m) => m.content));
    expect(diskContents('conv-race')).toEqual(['kept', 'rewound', 'after']);
  });

  it('carries nothing again that a failed save did not write', async () => {
    await store.initialize();
    const id = store.currentConversationId!;
    chat.setCurrentConversation(id);
    chat.addUserMessage('saved');
    await store.saveCurrentConversation();
    chat.addUserMessage('refused once');
    disk.failNext = 3; // the service retries three times before giving up
    expect(await store.saveCurrentConversation()).toBe(false);

    await store.saveCurrentConversation();

    expect(carried(saves.at(-1))).toEqual(['refused once']);
    expect(diskContents(id)).toEqual(['saved', 'refused once']);
  });

  it('keeps the whole discussion reachable when a save of one out of sight fails, not only what it carried', async () => {
    await store.initialize();
    const id = store.currentConversationId!;
    chat.setCurrentConversation(id);
    chat.addUserMessage('already saved');
    await store.saveCurrentConversation();
    const held = [...chat.messages, { id: 'late', role: 'assistant' as const, content: 'arrived later', timestamp: 5000 }];
    chat.setCurrentConversation(null);
    await settle();

    disk.failNext = 3;
    expect(await store.saveConversation(id, held)).toBe(false);

    expect(carried(saves.at(-1))).toEqual(['arrived later']);
    expect(chat.getBufferedMessages(id)?.map((m) => m.content)).toEqual(['already saved', 'arrived later']);
  });
});
