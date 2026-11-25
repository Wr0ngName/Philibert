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

import { disk, diskContents, files, onDisk, settle, startRealStack } from './support/real-stack';

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

/** The stored messages, in order. */
const onDiskMessages = (id: string): ChatMessage[] => onDisk(id)?.messages ?? [];

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

  it('carries the rewind and what it marked on screen, the rest marked in the file', async () => {
    seed('conv-r', ['kept', 'rewound']);
    await store.loadConversationList();
    await store.loadConversation('conv-r');
    chat.messages[1].turnUuid = 'turn-to-rewind';

    chat.markRewound('conv-r', 'turn-to-rewind', { at: 5000 });
    chat.addUserMessage('asked again');
    await store.saveCurrentConversation();

    expect(saves[0].rewound).toEqual({ fromId: 'conv-r-1', at: 5000 });
    expect(carried(saves[0])).toEqual(['rewound', 'asked again']);
    expect(diskContents('conv-r')).toEqual(['kept', 'rewound', 'asked again']);
    expect(onDiskMessages('conv-r').map((m) => m.rewoundAt)).toEqual([undefined, 5000, undefined]);
  });

  it('carries a rewind made while the one before was being written, to the next write', async () => {
    seed('conv-twice', ['kept', 'first', 'second']);
    await store.loadConversationList();
    await store.loadConversation('conv-twice');
    chat.messages[1].turnUuid = 'turn-first';
    chat.messages[2].turnUuid = 'turn-second';
    // The write of the first rewind, held until the second is made.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const update = ConversationService.prototype.update;
    vi.mocked(ConversationService.prototype.update).mockImplementationOnce(async function (this: ConversationService, u) {
      saves.push(structuredClone(u));
      await held;
      return update.call(this, u);
    });

    chat.markRewound('conv-twice', 'turn-second', { at: 5000 });
    const writing = store.saveCurrentConversation();
    await settle();
    chat.markRewound('conv-twice', 'turn-first', { at: 6000 });
    release();
    await writing;

    // The first landing does not take the second with it.
    expect(chat.pendingRewoundFor('conv-twice')).toEqual({ fromId: 'conv-twice-1', at: 6000 });
    await store.saveCurrentConversation();
    expect(saves.at(-1)?.rewound).toEqual({ fromId: 'conv-twice-1', at: 6000 });
    expect(chat.pendingRewoundFor('conv-twice')).toBeNull();
    expect(onDiskMessages('conv-twice').map((m) => m.rewoundAt)).toEqual([undefined, 6000, 5000]);
  });

  it('cannot be undone by what a read found before the rewind landed', async () => {
    // A read answering after a rewind landed holds the messages as they were
    // before it, unmarked. Saved back, they must not take the marks off:
    // Claude no longer has them, whatever a late page says.
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

    chat.markRewound('conv-race', 'turn-to-rewind', { at: 5000 });
    await store.saveCurrentConversation();
    expect(onDiskMessages('conv-race').map((m) => m.rewoundAt)).toEqual([undefined, 5000, 5000]);
    answer();
    const stale = await reading;

    // The stale messages come back on screen, as a late page would put them.
    chat.loadMessages(stale!.conversation.messages);
    expect(chat.messages.map((m) => m.rewoundAt)).toEqual([undefined, undefined, undefined]);
    await store.saveCurrentConversation();

    expect(diskContents('conv-race')).toEqual(['kept', 'rewound', 'after']);
    expect(onDiskMessages('conv-race').map((m) => m.rewoundAt)).toEqual([undefined, 5000, 5000]);
    expect(onDiskMessages('conv-race')[1].rewind).toEqual({ at: 5000 });
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
