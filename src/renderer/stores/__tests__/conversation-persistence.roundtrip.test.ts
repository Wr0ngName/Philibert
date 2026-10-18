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

import type { Conversation, ConversationUpdate } from '@shared/types';

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
  disk: {
    holdWrites: false,
    waiting: [] as (() => void)[],
    /**
     * Writes reject while this is set.
     *
     * Not a hypothetical: the reported loss came from the app's own refusal to
     * write, and a locked file, a full disk, a timeout or antivirus holding
     * the handle on Windows arrive at the renderer identically. What the
     * renderer does with the messages it failed to persist is the thing worth
     * testing, and it cannot be tested while every write succeeds.
     */
    failWrites: false,
  },
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
        if (disk.failWrites) {
          const err = new Error(`EBUSY: resource busy or locked, open '${p}'`) as NodeJS.ErrnoException;
          err.code = 'EBUSY';
          throw err;
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
    // Copied both ways as Electron copies them, which throws on what it cannot.
    invoke: vi.fn(async (channel: string, ...args: unknown[]) =>
      structuredClone(await route(channel, structuredClone(args)))),
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
    case IPC_CHANNELS.CONVERSATION_UPDATE:
      return conversationService.update(args[0] as ConversationUpdate);
    case IPC_CHANNELS.CONVERSATION_GET_WINDOW:
      return conversationService.getWindow(args[0] as string, args[1] as number);
    case IPC_CHANNELS.CONVERSATION_GET_OLDER:
      return conversationService.getOlder(
        args[0] as string, args[1] as string, args[2] as number,
      );
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
    disk.failWrites = false;
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

  it('saves the conversation the save was asked for, not whichever is current later', async () => {
    // Reported on a build that has every earlier fix: talk in one of two
    // conversations, the model answers, switch away, come back — prompt and
    // answer gone, older messages intact.
    //
    // The save queue defers the question of WHAT to save until the write
    // runs. So a save requested for one conversation, queued behind a write
    // in flight, and then overtaken by a switch, writes the conversation that
    // is current by then — and the turn it was asked to save is never
    // written at all.
    const wrapper = mountApp();

    const other = conversations.createNewConversation();
    await send(wrapper, 'elsewhere');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, other);
    await settle();

    const subject = conversations.createNewConversation();
    await send(wrapper, 'an earlier question');
    streamAssistant(subject, 'an earlier answer');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, subject);
    await settle();

    // From here the disk is slow, so the next save is still writing when the
    // turn after it asks to be saved.
    disk.holdWrites = true;

    await send(wrapper, 'the question that disappears');
    streamAssistant(subject, 'the answer that disappears');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, subject);
    await settle();

    // The user switches while that save is still queued.
    const switching = conversations.switchConversation(other);
    await releaseWrites();
    await switching;
    await settle();

    await conversations.switchConversation(subject);
    await settle();

    expect(diskContents(subject)).toEqual([
      'an earlier question',
      'an earlier answer',
      'the question that disappears',
      'the answer that disappears',
    ]);
  });

  it('keeps both turns when two conversations run at once and overlap', async () => {
    // "Two discussions going on in parallel": a turn can END while the user
    // is in the OTHER conversation, which takes the background save path
    // rather than the current-conversation one — a path the sequential tests
    // never exercise.
    const wrapper = mountApp();

    const alpha = conversations.createNewConversation();
    await send(wrapper, 'alpha question');
    await settle();

    // Switch away while alpha's turn is still running.
    const bravo = conversations.createNewConversation();
    await send(wrapper, 'bravo question');
    await settle();

    // Both answer, alpha's arriving while the user is looking at bravo.
    streamAssistant(alpha, 'alpha answer');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, alpha);
    await settle();
    streamAssistant(bravo, 'bravo answer');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, bravo);
    await settle();

    // Back to alpha.
    await conversations.switchConversation(alpha);
    await settle();

    expect(chat.messages.map((m) => m.content)).toEqual([
      'alpha question',
      'alpha answer',
    ]);
    expect(diskContents(alpha)).toEqual(['alpha question', 'alpha answer']);
    expect(diskContents(bravo)).toEqual(['bravo question', 'bravo answer']);
  });

  it('keeps a second turn taken in a conversation returned to', async () => {
    // The sequence continued: come back, talk again, leave, return. A stale
    // buffer or a refused save would show up here rather than on the first
    // round trip.
    const wrapper = mountApp();

    const alpha = conversations.createNewConversation();
    await send(wrapper, 'first question');
    streamAssistant(alpha, 'first answer');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, alpha);
    await settle();

    const bravo = conversations.createNewConversation();
    await send(wrapper, 'elsewhere');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, bravo);
    await settle();

    await conversations.switchConversation(alpha);
    await settle();

    // A second turn, after the round trip.
    await send(wrapper, 'second question');
    streamAssistant(alpha, 'second answer');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, alpha);
    await settle();

    await conversations.switchConversation(bravo);
    await settle();
    await conversations.switchConversation(alpha);
    await settle();

    expect(chat.messages.map((m) => m.content)).toEqual([
      'first question',
      'first answer',
      'second question',
      'second answer',
    ]);
  });

  it('keeps a COMPLETED turn when the user switches away and comes back', async () => {
    // Reported: two conversations in parallel, talk in one, the model answers,
    // switch away, come back — and both the prompt and the answer are gone
    // while older messages survive.
    //
    // Distinct from the mid-turn case below: here the turn ENDS while the
    // conversation is on screen, so its buffer is released and the switch
    // back must come from the saved file.
    const wrapper = mountApp();

    const second = conversations.createNewConversation();
    await send(wrapper, 'over here');
    streamAssistant(second, 'fine');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, second);
    await settle();

    const first = conversations.createNewConversation();
    await send(wrapper, 'an earlier question');
    streamAssistant(first, 'an earlier answer');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, first);
    await settle();

    // The turn the report is about: asked and answered, with the conversation
    // in view the whole time.
    await send(wrapper, 'the question that disappears');
    streamAssistant(first, 'the answer that disappears');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, first);
    await settle();

    expect(chat.messages).toHaveLength(4);

    // Away, then back.
    await conversations.switchConversation(second);
    await settle();
    await conversations.switchConversation(first);
    await settle();

    expect(chat.messages.map((m) => m.content)).toEqual([
      'an earlier question',
      'an earlier answer',
      'the question that disappears',
      'the answer that disappears',
    ]);
    expect(diskContents(first)).toEqual([
      'an earlier question',
      'an earlier answer',
      'the question that disappears',
      'the answer that disappears',
    ]);
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

  it('keeps saving after a REAL rewind followed by new turns', async () => {
    // The test that was missing, and the reason a write-blocking guard shipped
    // for three releases without anyone noticing.
    //
    // Rewind and the save guard were each tested alone. Nothing drove a real
    // rewind and then kept talking, which is the only way to produce the shape
    // that broke: a history that keeps its opening, diverges in the middle,
    // and ends up LONGER than what is stored. Modelled as a pure truncation —
    // which is how the guard's own tests modelled it — it looks safe.
    const wrapper = mountApp();
    const id = conversations.createNewConversation();
    await settle();

    await send(wrapper, 'the question kept by the rewind');
    // The CLI's id for that turn, which is what a rewind targets.
    emitIpc(IPC_CHANNELS.CLAUDE_USER_TURN_UUID, id, 'turn-uuid-1');
    streamAssistant(id, 'an answer that will be rewound away');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, id);
    await settle();

    await send(wrapper, 'a second question, also rewound away');
    streamAssistant(id, 'and its answer');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, id);
    await settle();
    expect(diskContents(id)).toHaveLength(4);

    // Rewind to the first turn, through the store action the modal calls.
    chat.truncateAfterUserTurn(id, 'turn-uuid-1');
    await settle();
    expect(chat.messages).toHaveLength(0);

    // Then carry on talking, which is what makes the next save diverge from
    // the file mid-list rather than simply truncating it.
    await send(wrapper, 'asked again after the rewind');
    streamAssistant(id, 'a different answer');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, id);
    await settle();

    expect(diskContents(id)).toEqual([
      'asked again after the rewind',
      'a different answer',
    ]);
  });

  it('writes a transcript that diverges mid-list, such as after a rewind', async () => {
    // This used to be refused. A guard compared the incoming transcript with
    // the stored one and rejected anything that was not an extension or a
    // truncation, to stop a fragment overwriting a full history.
    //
    // It caused the loss it was meant to prevent. From the reported log, on a
    // real conversation:
    //
    //   storedCount: 11745, incomingCount: 12180
    //   storedFirstId === incomingFirstId
    //
    // An extension of 435 messages, same opening — diverging in the middle,
    // which is what a rewind followed by new turns produces. Every save was
    // refused, retried three times and abandoned, so the file kept the old
    // content and everything since vanished.
    const wrapper = mountApp();
    const id = conversations.createNewConversation();
    await settle();

    await send(wrapper, 'first question');
    streamAssistant(id, 'first answer');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, id);
    await settle();

    const stored = onDisk(id)!;
    // A history that keeps the opening, drops what followed, and adds more —
    // the shape a rewind-and-continue leaves behind.
    const diverged = {
      ...stored,
      messages: [
        stored.messages[0],
        { id: 'msg-after-rewind-1', role: 'assistant', content: 'a different answer', timestamp: 2 },
        { id: 'msg-after-rewind-2', role: 'user', content: 'and more', timestamp: 3 },
      ],
    } as Conversation;

    await conversationService.save(diverged);

    expect(diskContents(id)).toEqual(['first question', 'a different answer', 'and more']);
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

  /**
   * The model's task list across a restart.
   *
   * It lived only in the chat store, so closing the app emptied the panel
   * while the work it described was half done — and because the model keeps
   * its own copy, the next `TaskUpdate` named a task the app no longer knew
   * and was dropped as unknown.
   *
   * Driven through the real capture and result events, so the list is built
   * by the same code that builds it in the app, then read back after a real
   * reload: new stores, same files, same service.
   */
  describe('the task list after a restart', () => {
    /** The SDK capture for a Task* call, as the main process forwards it. */
    function taskCall(id: string, blockId: string, toolName: string, input: Record<string, unknown>) {
      emitIpc(IPC_CHANNELS.CLAUDE_TOOL_CAPTURE, id, {
        toolUseBlockId: blockId,
        toolName,
        input,
        description: toolName,
      });
    }

    /** The result of a TaskCreate, carrying the SDK-assigned task id. */
    function taskCreated(id: string, blockId: string, taskListId: string) {
      emitIpc(IPC_CHANNELS.CLAUDE_TOOL_RESULT, id, {
        toolUseBlockId: blockId,
        outputFile: `/tmp/${blockId}.txt`,
        taskListId,
      });
    }

    /** Start a conversation and leave it holding a three-item task list. */
    async function conversationWithTasks(wrapper: ReturnType<typeof mount>): Promise<string> {
      const id = conversations.createNewConversation();
      await settle();

      await send(wrapper, 'plan the work');

      taskCall(id, 'toolu_1', 'TaskCreate', {
        subject: 'Write the parser',
        description: 'tokenise, then build the tree',
        activeForm: 'Writing the parser',
      });
      taskCreated(id, 'toolu_1', 'task_aaa');
      taskCall(id, 'toolu_2', 'TaskCreate', { subject: 'Cover it with tests' });
      taskCreated(id, 'toolu_2', 'task_bbb');
      taskCall(id, 'toolu_3', 'TaskCreate', { subject: 'Wire up the CLI' });
      taskCreated(id, 'toolu_3', 'task_ccc');

      // Progress: one finished, one under way.
      taskCall(id, 'toolu_4', 'TaskUpdate', { taskId: 'task_aaa', status: 'completed' });
      taskCall(id, 'toolu_5', 'TaskUpdate', { taskId: 'task_bbb', status: 'in_progress' });

      streamAssistant(id, 'starting on the tests');
      emitIpc(IPC_CHANNELS.CLAUDE_DONE, id);
      await settle(40);
      return id;
    }

    /**
     * A fresh renderer against the same files: new stores, the app mounted
     * again so the real IPC handlers are in place, same service.
     */
    async function restart(id: string) {
      mounted?.unmount();
      mounted = null;
      setActivePinia(createPinia());
      conversations = useConversationsStore();
      chat = useChatStore();
      const settings = useSettingsStore();
      settings.config.workingDirectory = '/home/user/project';
      settings.config.apiKey = 'test-key';
      await conversations.loadConversationList();
      await settle();
      const wrapper = mountApp();
      await conversations.loadConversation(id);
      await settle();
      return wrapper;
    }

    it('comes back with every item, its status and its wording intact', async () => {
      const wrapper = mountApp();
      const id = await conversationWithTasks(wrapper);

      const before = chat.taskListItems.map((t) => ({ ...t }));
      expect(before.map((t) => [t.id, t.status])).toEqual([
        ['task_aaa', 'completed'],
        ['task_bbb', 'in_progress'],
        ['task_ccc', 'pending'],
      ]);
      expect(before[0]).toMatchObject({
        subject: 'Write the parser',
        description: 'tokenise, then build the tree',
        activeForm: 'Writing the parser',
      });

      await restart(id);

      // Exactly what was there, not an approximation of it.
      expect(chat.taskListItems).toEqual(before);
    });

    it('keeps the order the model created them in', async () => {
      const wrapper = mountApp();
      const id = await conversationWithTasks(wrapper);

      await restart(id);

      expect(chat.taskListItems.map((t) => t.subject)).toEqual([
        'Write the parser',
        'Cover it with tests',
        'Wire up the CLI',
      ]);
    });

    it('accepts an update for a task created before the restart', async () => {
      // The point of persisting the ids. The model's own list survives in its
      // session, so its next update names `task_ccc` — which used to be
      // dropped with "update for unknown taskId", leaving the panel wrong for
      // the rest of the conversation.
      const wrapper = mountApp();
      const id = await conversationWithTasks(wrapper);
      await restart(id);

      taskCall(id, 'toolu_6', 'TaskUpdate', { taskId: 'task_ccc', status: 'in_progress' });
      await settle();

      expect(chat.taskListItems.find((t) => t.id === 'task_ccc')?.status).toBe('in_progress');
    });

    it('writes the list into the conversation file', async () => {
      const wrapper = mountApp();
      const id = await conversationWithTasks(wrapper);

      expect(onDisk(id)?.taskList?.map((t) => [t.id, t.status])).toEqual([
        ['task_aaa', 'completed'],
        ['task_bbb', 'in_progress'],
        ['task_ccc', 'pending'],
      ]);
    });

    it('does not lose the saved list when saving a conversation it has not loaded', async () => {
      // A background save builds its payload from a state that may hold no
      // task list at all; writing an empty one over a real one destroys it.
      const wrapper = mountApp();
      const id = await conversationWithTasks(wrapper);
      const saved = onDisk(id)?.taskList;
      expect(saved).toHaveLength(3);

      // A different renderer state, as a restart that never opened this
      // conversation would have.
      await restart(id);
      const other = conversations.createNewConversation();
      await settle();

      await conversations.saveConversation(other, [
        { id: 'm-other', role: 'user', content: 'elsewhere', timestamp: Date.now() },
      ]);
      await settle();

      expect(onDisk(id)?.taskList).toEqual(saved);
    });

    it('replays the Task* calls for a conversation saved before the list was', async () => {
      // Migration. An older file has neither the list nor the task ids on its
      // tool uses, so the transcript is the only evidence and a create cannot
      // be matched to the updates that followed it. The items and their
      // wording come back; their progress does not, which is the honest
      // reading of what survived — and better than an empty panel.
      const wrapper = mountApp();
      const id = await conversationWithTasks(wrapper);

      const stored = onDisk(id) as Conversation;
      delete stored.taskList;
      for (const message of stored.messages) {
        if (message.toolUse) delete message.toolUse.taskListId;
      }
      files.set(`/conversations/${id}.json`, JSON.stringify(stored));

      await restart(id);

      expect(chat.taskListItems.map((t) => t.subject)).toEqual([
        'Write the parser',
        'Cover it with tests',
        'Wire up the CLI',
      ]);
      expect(chat.taskListItems.map((t) => t.status)).toEqual([
        'pending',
        'pending',
        'pending',
      ]);
    });
  });

  /**
   * What happens to a turn the disk would not take.
   *
   * This is the mechanism behind the reported loss, and it outlives the cause
   * that exposed it. The app's own save guard refused three writes in a row,
   * so the file kept an older history — but the renderer treats a failed save
   * as nothing at all: `switchConversation` awaited it, ignored the result,
   * and replaced the message list, which was the only copy of everything
   * since the last successful write. Coming back read the file. Prompt and
   * answer gone, older messages intact, exactly as reported.
   *
   * The guard is gone, and a locked file, a full disk, a save timeout or
   * antivirus holding the handle produce the same failure. So the renderer
   * has to stop discarding what it could not persist.
   */
  describe('a save the disk refused', () => {
    /**
     * Wait out the turn-end handler.
     *
     * It is an async IPC listener and nothing returns its promise, so the
     * number of ticks it needs is not something a caller can know — and it
     * now awaits the whole save queue before releasing the buffer. Asserting
     * on the buffer too early reads it mid-flight, which looks exactly like
     * the defect under test.
     */
    async function afterTurn(): Promise<void> {
      await settle(40);
    }

    /** Long enough for the service's three attempts (100ms + 200ms backoff). */
    async function afterRetries(): Promise<void> {
      await new Promise<void>((resolve) => setTimeout(resolve, 450));
      await afterTurn();
    }

    it('keeps the turn reachable when the user switches away and back', async () => {
      const wrapper = mountApp();
      const first = conversations.createNewConversation();
      await settle();
      await send(wrapper, 'older question');
      streamAssistant(first, 'older answer');
      emitIpc(IPC_CHANNELS.CLAUDE_DONE, first);
      await afterTurn();

      const second = conversations.createNewConversation();
      await settle();
      await send(wrapper, 'in the other one');
      streamAssistant(second, 'other answer');
      emitIpc(IPC_CHANNELS.CLAUDE_DONE, second);
      await afterTurn();

      await conversations.switchConversation(first);
      await settle();
      expect(diskContents(first)).toEqual(['older question', 'older answer']);

      // From here the disk will not take a write.
      disk.failWrites = true;
      await send(wrapper, 'new question');
      streamAssistant(first, 'new answer');
      emitIpc(IPC_CHANNELS.CLAUDE_DONE, first);
      await afterRetries();

      // The file is unchanged — that part is the disk's doing, not ours.
      expect(diskContents(first)).toEqual(['older question', 'older answer']);

      // The user switches away, then comes back. This is where the messages
      // used to disappear: the list was replaced, and the file is older.
      await conversations.switchConversation(second);
      await afterRetries();
      await conversations.switchConversation(first);
      await settle();

      expect(chat.messages.map((m) => m.content)).toEqual([
        'older question',
        'older answer',
        'new question',
        'new answer',
      ]);
    });

    it('writes the kept turn once the disk takes writes again', async () => {
      // Retained is not persisted. The messages have to reach disk on the
      // next opportunity, or they are still lost — just later.
      const wrapper = mountApp();
      const id = conversations.createNewConversation();
      await settle();
      await send(wrapper, 'older question');
      streamAssistant(id, 'older answer');
      emitIpc(IPC_CHANNELS.CLAUDE_DONE, id);
      await afterTurn();

      disk.failWrites = true;
      await send(wrapper, 'new question');
      streamAssistant(id, 'new answer');
      emitIpc(IPC_CHANNELS.CLAUDE_DONE, id);
      await afterRetries();
      expect(diskContents(id)).toEqual(['older question', 'older answer']);

      // Off screen, so the on-screen list is no longer a copy of it: what is
      // retained is all there is. Switching is also another failed save.
      const elsewhere = conversations.createNewConversation();
      await settle();
      await send(wrapper, 'elsewhere');
      emitIpc(IPC_CHANNELS.CLAUDE_DONE, elsewhere);
      await afterRetries();

      disk.failWrites = false;
      // Closing the app flushes what is held in memory, which now includes
      // the turn that failed.
      await conversations.cleanup();
      await settle();

      expect(diskContents(id)).toEqual([
        'older question',
        'older answer',
        'new question',
        'new answer',
      ]);
    });

    it('stops keeping the turn once it is on disk', async () => {
      // Retention makes the in-memory copy authoritative over the file, which
      // is only safe for as long as the file is behind. Holding it after a
      // successful write would be a stale buffer shadowing good data — the
      // defect `repointBufferToScreen` exists for, arrived at from the other
      // direction.
      const wrapper = mountApp();
      const first = conversations.createNewConversation();
      await settle();
      await send(wrapper, 'older question');
      streamAssistant(first, 'older answer');
      emitIpc(IPC_CHANNELS.CLAUDE_DONE, first);
      await afterTurn();
      expect(chat.getBufferedMessages(first)).toBeNull();

      disk.failWrites = true;
      await send(wrapper, 'kept question');
      streamAssistant(first, 'kept answer');
      emitIpc(IPC_CHANNELS.CLAUDE_DONE, first);
      await afterRetries();
      expect(chat.getBufferedMessages(first)).toHaveLength(4);

      disk.failWrites = false;
      await send(wrapper, 'last question');
      streamAssistant(first, 'last answer');
      emitIpc(IPC_CHANNELS.CLAUDE_DONE, first);
      await afterTurn();

      expect(chat.getBufferedMessages(first)).toBeNull();
      expect(diskContents(first)).toEqual([
        'older question',
        'older answer',
        'kept question',
        'kept answer',
        'last question',
        'last answer',
      ]);

      const second = conversations.createNewConversation();
      await settle();
      await send(wrapper, 'elsewhere');
      emitIpc(IPC_CHANNELS.CLAUDE_DONE, second);
      await afterTurn();
      await conversations.switchConversation(first);
      await settle();

      expect(chat.messages.map((m) => m.content)).toEqual([
        'older question',
        'older answer',
        'kept question',
        'kept answer',
        'last question',
        'last answer',
      ]);
    });
  });
});
