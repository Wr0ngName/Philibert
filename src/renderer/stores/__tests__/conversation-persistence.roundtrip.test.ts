/**
 * Does a conversation actually survive, through the real machinery?
 *
 * The other tests for this were weaker than the bugs they covered. They
 * asserted invariants against hand-written fakes of our own preload API, and
 * drove the switch by calling store actions in the order I believed
 * `loadConversation` uses — which is assuming the very thing that was broken.
 * Both data-loss defects lived in the seams between the renderer's save
 * queue, the background buffer, the switch sequence and the file on disk, so a
 * test that replaces any of those with a stand-in cannot see them.
 *
 * So here nothing of ours is faked:
 *
 *  - the renderer runs the real chat and conversations stores, and the real
 *    ChatWindow, so the real IPC handlers in useClaudeChat drive the stores;
 *  - `window.electron` is built by our real preload;
 *  - behind the IPC transport sits the REAL main-process ConversationService,
 *    so conversations are really serialised to JSON, really written, really
 *    read back, and really parsed;
 *  - only two things are mocked, both genuinely external: Electron itself, and
 *    the filesystem, which is an in-memory map.
 *
 * What is NOT covered: the Claude SDK (no turn really runs — turn events are
 * delivered as the main process would deliver them), and Electron's own
 * process lifecycle. Everything between the keystroke and the bytes is real.
 */

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';

import type { Conversation } from '@shared/types';

type IpcHandler = (event: unknown, ...args: unknown[]) => void;

const { ipcListeners, exposed, files, disk } = vi.hoisted(() => ({
  ipcListeners: new Map<string, ((event: unknown, ...args: unknown[]) => void)[]>(),
  exposed: { api: null as Record<string, unknown> | null },
  /** The "disk": path → file contents. */
  files: new Map<string, string>(),
  /**
   * Control over how long a write takes.
   *
   * An in-memory write finishes within the same tick, which quietly removed a
   * whole class of defect from this test's reach: saves could never actually
   * overlap, so restoring the old "refuse to save while one is in flight"
   * guard left every assertion passing. A real write takes long enough for
   * the next one to be requested while it is still going, and that is exactly
   * when messages were lost — so the disk has to be able to be slow.
   */
  disk: { holdWrites: false, waiting: [] as (() => void)[] },
}));

/** An in-memory filesystem, standing in for the only truly external thing. */
vi.mock('node:fs', () => {
  const dirs = new Set<string>(['/conversations']);
  const api = {
    // The real service checks writability with fs.constants.W_OK. Leaving
    // these out made every save throw a TypeError that the service logged and
    // swallowed — a reminder of why the fake surface has to match the real
    // module rather than only the calls one expects.
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
    existsSync: (p: string) => dirs.has(p) || files.has(p),
    mkdirSync: (p: string) => {
      dirs.add(p);
    },
    promises: {
      readdir: async () => [...files.keys()].map((p) => p.split('/').pop() as string),
      readFile: async (p: string) => {
        const content = files.get(p);
        if (content === undefined) {
          const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return content;
      },
      writeFile: async (p: string, content: string) => {
        if (disk.holdWrites) {
          await new Promise<void>((resolve) => disk.waiting.push(resolve));
        }
        files.set(p, content);
      },
      unlink: async (p: string) => {
        files.delete(p);
      },
      access: async (p: string) => {
        if (!dirs.has(p) && !files.has(p)) {
          const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
      },
      mkdir: async (p: string) => {
        dirs.add(p);
      },
      stat: async () => ({ isDirectory: () => true, size: 0 }),
    },
  };
  return { default: api, ...api };
});

vi.mock('../../../main/utils/paths', () => ({
  getConversationsPath: () => '/conversations',
  isPathWithin: () => true,
}));

vi.mock('../../../main/utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogLevel: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, unknown>) => {
      exposed.api = api;
    },
  },
  ipcRenderer: {
    // Routed to the real services below, once they are constructed.
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => route(channel, args)),
    send: vi.fn(),
    on: (channel: string, handler: IpcHandler) => {
      const list = ipcListeners.get(channel) ?? [];
      list.push(handler);
      ipcListeners.set(channel, list);
    },
    removeListener: (channel: string, handler: IpcHandler) => {
      const list = ipcListeners.get(channel) ?? [];
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    },
  },
}));

// The real main-process persistence, running against the in-memory fs.
import { ConversationService } from '../../../main/services/ConversationService';
import { IPC_CHANNELS } from '../../../shared/types';
import ChatWindow from '../../components/chat/ChatWindow.vue';
import { useChatStore } from '../chat';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

// Importing the real preload populates `exposed.api`.
import '../../../preload/preload';

let conversationService: ConversationService;

/** Config the renderer reads at startup, as the main process would supply it. */
let storedConfig: Record<string, unknown> = {};

/**
 * The IPC transport. Conversation channels reach the real service; the rest
 * answer the way the main process would, since no SDK runs here.
 */
async function route(channel: string, args: unknown[]): Promise<unknown> {
  switch (channel) {
    case IPC_CHANNELS.CONVERSATION_SAVE:
      return conversationService.save(args[0] as Conversation);
    case IPC_CHANNELS.CONVERSATION_GET:
      return conversationService.get(args[0] as string);
    case IPC_CHANNELS.CONVERSATION_LIST:
      return conversationService.list();
    case IPC_CHANNELS.CONVERSATION_DELETE:
      return conversationService.delete(args[0] as string);
    case IPC_CHANNELS.CONFIG_GET:
      return storedConfig;
    case IPC_CHANNELS.CONFIG_SET:
      storedConfig = { ...storedConfig, ...(args[0] as Record<string, unknown>) };
      return undefined;
    default:
      if (/availability/i.test(channel)) return { available: false };
      if (/commands|models|list|queries|permissions/i.test(channel)) return [];
      return undefined;
  }
}

/** Let every held write complete. */
async function releaseWrites(): Promise<void> {
  disk.holdWrites = false;
  const waiting = [...disk.waiting];
  disk.waiting.length = 0;
  for (const resolve of waiting) resolve();
  await settle(12);
}

function emitIpc(channel: string, ...args: unknown[]) {
  for (const handler of [...(ipcListeners.get(channel) ?? [])]) {
    handler({}, ...args);
  }
}

async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) await nextTick();
}

/** What is actually on disk for a conversation, parsed from its JSON. */
function onDisk(id: string): Conversation | null {
  const raw = files.get(`/conversations/${id}.json`);
  return raw ? (JSON.parse(raw) as Conversation) : null;
}

function diskContents(id: string): string[] {
  return (onDisk(id)?.messages ?? []).map((m) => m.content);
}

let mounted: ReturnType<typeof mount> | null = null;

function mountApp() {
  const wrapper = mount(ChatWindow);
  if (!ipcListeners.has(IPC_CHANNELS.CLAUDE_DONE)) {
    throw new Error('useClaudeChat did not subscribe — mount failed silently');
  }
  mounted = wrapper;
  return wrapper;
}

/** Type a prompt and press Enter, as the user does. */
async function send(wrapper: ReturnType<typeof mount>, text: string) {
  const textarea = wrapper.find('textarea');
  await textarea.setValue(text);
  await textarea.trigger('keydown', { key: 'Enter' });
  await settle();
}

describe('a conversation through the real persistence stack', () => {
  let conversations: ReturnType<typeof useConversationsStore>;
  let chat: ReturnType<typeof useChatStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    files.clear();
    ipcListeners.clear();
    disk.holdWrites = false;
    disk.waiting.length = 0;

    if (!exposed.api) throw new Error('preload did not expose its API');
    (globalThis as unknown as { window: Record<string, unknown> }).window.electron = exposed.api;

    conversationService = new ConversationService();

    storedConfig = {
      workingDirectory: '/home/user/project',
      apiKey: 'test-key',
      recentProjects: [],
      theme: 'system',
    };

    conversations = useConversationsStore();
    chat = useChatStore();

    const settings = useSettingsStore();
    settings.config.workingDirectory = '/home/user/project';
    settings.config.apiKey = 'test-key';

    // Real startup: the list comes from the real service, and loading it is
    // what arms the auto-save watchers.
    await conversations.loadConversationList();
    await settle();
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
  });

  /**
   * Deliver a turn's worth of events the way the main process does, for a
   * conversation that may or may not be the one on screen.
   */
  function streamAssistant(conversationId: string, text: string) {
    emitIpc(IPC_CHANNELS.CLAUDE_CHUNK, conversationId, text);
  }

  it('writes a completed turn to disk, readable as JSON', async () => {
    const wrapper = mountApp();
    const id = conversations.createNewConversation();
    await settle();

    await send(wrapper, 'first question');
    streamAssistant(id, 'the answer');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, id);
    await settle();

    expect(diskContents(id)).toEqual(['first question', 'the answer']);
  });

  it('keeps the whole turn when the user switches away mid-turn and back', async () => {
    // The defect this is really about: the background buffer was seeded as a
    // copy at turn start, so everything produced while the conversation was on
    // screen was missing from it — and the buffer is both what the switch-back
    // renders and what the turn's end writes to disk.
    const wrapper = mountApp();
    const first = conversations.createNewConversation();
    await settle();

    await send(wrapper, 'question in the first conversation');
    // Part of the answer arrives while the user is watching.
    streamAssistant(first, 'first half of the answer. ');
    await settle();

    // Away to a second conversation, while the first keeps running.
    const second = conversations.createNewConversation();
    await settle();
    expect(conversations.currentConversationId).toBe(second);

    // The rest of the turn lands in the background, then it finishes.
    streamAssistant(first, 'second half of the answer.');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, first);
    await settle();

    // On disk, in full.
    expect(diskContents(first)).toEqual([
      'question in the first conversation',
      'first half of the answer. second half of the answer.',
    ]);

    // And on screen when the user returns, through the real load path.
    await conversations.switchConversation(first);
    await settle();
    expect(chat.messages.map((m) => m.content)).toEqual([
      'question in the first conversation',
      'first half of the answer. second half of the answer.',
    ]);
  });

  it('loses nothing when the user switches the instant a turn ends', async () => {
    // Where the dropped save bit: the turn's save and the switch's save are
    // requested together, and the switch then replaces the message list.
    const wrapper = mountApp();
    const first = conversations.createNewConversation();
    await settle();

    await send(wrapper, 'a question');
    streamAssistant(first, 'an answer');

    // Both at once, deliberately not settled in between.
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, first);
    const switching = conversations.switchConversation(
      conversations.createNewConversation(),
    );
    await switching;
    await settle();

    expect(diskContents(first)).toEqual(['a question', 'an answer']);
  });

  it('keeps messages written while the previous save was still being written', async () => {
    // The dropped-save defect, through the real stack. It needs two things at
    // once: a write still in flight, and messages arriving after that write
    // took its snapshot. The old guard refused the second save outright, and
    // the switch then replaced the message list — so those messages existed
    // nowhere.
    const wrapper = mountApp();
    // Somewhere to go afterwards, created and saved up front so switching to
    // it is a plain switch rather than also being a "new conversation".
    const elsewhere = conversations.createNewConversation();
    await send(wrapper, 'unrelated');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, elsewhere);
    await settle();

    const first = conversations.createNewConversation();
    await settle();

    await send(wrapper, 'a question');
    streamAssistant(first, 'an answer');

    // The turn ends, which starts a save. The disk is slow from here.
    disk.holdWrites = true;
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, first);
    await settle();

    // The user carries straight on while that write is still going.
    await send(wrapper, 'a second question');
    streamAssistant(first, 'a second answer');
    await settle();

    // And then leaves for a conversation that already exists, which is what
    // made the loss permanent.
    const switching = conversations.switchConversation(elsewhere);
    await releaseWrites();
    await switching;
    await settle();

    expect(diskContents(first)).toEqual([
      'a question',
      'an answer',
      'a second question',
      'a second answer',
    ]);
  });

  it('persists a background turn when the app closes mid-turn', async () => {
    const wrapper = mountApp();
    const first = conversations.createNewConversation();
    await settle();

    await send(wrapper, 'started before closing');
    streamAssistant(first, 'partial answer');
    await settle();

    // Away, so the turn is now collecting in the background, and close.
    conversations.createNewConversation();
    await settle();
    streamAssistant(first, ' and a bit more');
    await settle();

    await conversations.cleanup();

    expect(diskContents(first)).toEqual([
      'started before closing',
      'partial answer and a bit more',
    ]);
  });

  it('survives a round trip after a reload, with order intact', async () => {
    const wrapper = mountApp();
    const id = conversations.createNewConversation();
    await settle();

    await send(wrapper, 'one');
    streamAssistant(id, 'two');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, id);
    await settle();

    // A fresh renderer against the same files: new stores, same service.
    mounted?.unmount();
    mounted = null;
    setActivePinia(createPinia());
    const reloaded = useConversationsStore();
    const reloadedChat = useChatStore();
    useSettingsStore().config.workingDirectory = '/home/user/project';

    await reloaded.loadConversationList();
    await reloaded.loadConversation(id);
    await settle();

    expect(reloadedChat.messages.map((m) => m.content)).toEqual(['one', 'two']);
    expect(reloadedChat.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('does not leave a message marked as streaming on disk', async () => {
    // A persisted message with isStreaming true shows a spinner for a turn
    // that ended, possibly in a previous run of the app.
    const wrapper = mountApp();
    const id = conversations.createNewConversation();
    await settle();

    await send(wrapper, 'question');
    streamAssistant(id, 'answer');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, id);
    await settle();

    expect((onDisk(id)?.messages ?? []).some((m) => m.isStreaming)).toBe(false);
  });

  it('refuses a write that would drop messages already on disk', async () => {
    // The guard at the point of destruction, exercised through the real
    // service. The renderer prefers its in-memory buffer to this file and
    // writes that buffer when a turn ends, and a buffer missing the start of
    // a transcript has twice been written over a complete one. The renderer
    // causes are fixed; this makes the file safe regardless.
    const wrapper = mountApp();
    const id = conversations.createNewConversation();
    await settle();

    await send(wrapper, 'first question');
    streamAssistant(id, 'first answer');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, id);
    await settle();

    const complete = onDisk(id);
    expect(complete?.messages.length).toBe(2);

    // A fragment: the same conversation, but missing its opening messages.
    const fragment = {
      ...complete!,
      messages: [{ id: 'msg-from-nowhere', role: 'assistant', content: 'orphan', timestamp: 1 }],
    } as Conversation;

    await expect(conversationService.save(fragment)).rejects.toThrow(/diverges/);

    // And the file still has everything.
    expect(diskContents(id)).toEqual(['first question', 'first answer']);
  });

  it('still allows a rewind, which truncates from the end', async () => {
    // The guard must not block the one legitimate way a transcript shrinks.
    const wrapper = mountApp();
    const id = conversations.createNewConversation();
    await settle();

    await send(wrapper, 'first question');
    streamAssistant(id, 'first answer');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, id);
    await settle();

    const complete = onDisk(id)!;
    const truncated = { ...complete, messages: complete.messages.slice(0, 1) } as Conversation;

    await conversationService.save(truncated);

    expect(diskContents(id)).toEqual(['first question']);
  });

  it('keeps two conversations apart on disk', async () => {
    const wrapper = mountApp();
    const first = conversations.createNewConversation();
    await settle();
    await send(wrapper, 'in the first');
    streamAssistant(first, 'answer one');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, first);
    await settle();

    const second = conversations.createNewConversation();
    await settle();
    await send(wrapper, 'in the second');
    streamAssistant(second, 'answer two');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, second);
    await settle();

    expect(diskContents(first)).toEqual(['in the first', 'answer one']);
    expect(diskContents(second)).toEqual(['in the second', 'answer two']);
  });
});
