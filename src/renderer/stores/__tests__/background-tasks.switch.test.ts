/**
 * Do background tasks survive switching conversation?
 *
 * Reported as the list of background tasks sometimes going missing after a
 * switch. The panel renders `runningBackgroundTasksList`, which is the current
 * conversation's `backgroundTasks` map filtered to 'running', so there are
 * several distinct ways for it to come up empty and they need telling apart:
 * the map losing entries, the entries losing their running status, or the map
 * never having been persisted in the first place.
 *
 * Driven through the real stores, the real ChatWindow and the real preload,
 * with the real ConversationService behind the IPC boundary — tasks arrive as
 * task notifications from the main process, and switches go through
 * `switchConversation`, exactly as the app does it.
 */

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';

import type { Conversation } from '@shared/types';

type IpcHandler = (event: unknown, ...args: unknown[]) => void;

const { ipcListeners, exposed, files } = vi.hoisted(() => ({
  ipcListeners: new Map<string, ((event: unknown, ...args: unknown[]) => void)[]>(),
  exposed: { api: null as Record<string, unknown> | null },
  files: new Map<string, string>(),
}));

vi.mock('node:fs', () => {
  const dirs = new Set<string>(['/conversations']);
  const api = {
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

import { ConversationService } from '../../../main/services/ConversationService';
import { IPC_CHANNELS } from '../../../shared/types';
import ChatWindow from '../../components/chat/ChatWindow.vue';
import { useChatStore } from '../chat';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import '../../../preload/preload';

let conversationService: ConversationService;
let storedConfig: Record<string, unknown> = {};

async function route(channel: string, args: unknown[]): Promise<unknown> {
  switch (channel) {
    case IPC_CHANNELS.CONVERSATION_SAVE:
      return conversationService.save(args[0] as Conversation);
    case IPC_CHANNELS.CONVERSATION_GET:
      return conversationService.get(args[0] as string);
    case IPC_CHANNELS.CONVERSATION_LIST:
      return conversationService.list();
    case IPC_CHANNELS.CONFIG_GET:
      return storedConfig;
    default:
      if (/availability/i.test(channel)) return { available: false };
      if (/commands|models|list|queries|permissions/i.test(channel)) return [];
      return undefined;
  }
}

function emitIpc(channel: string, ...args: unknown[]) {
  for (const handler of [...(ipcListeners.get(channel) ?? [])]) {
    handler({}, ...args);
  }
}

async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) await nextTick();
}

let mounted: ReturnType<typeof mount> | null = null;

function mountApp() {
  const wrapper = mount(ChatWindow);
  if (!ipcListeners.has(IPC_CHANNELS.CLAUDE_TASK_NOTIFICATION)) {
    throw new Error('useClaudeChat did not subscribe — mount failed silently');
  }
  mounted = wrapper;
  return wrapper;
}

async function send(wrapper: ReturnType<typeof mount>, text: string) {
  const textarea = wrapper.find('textarea');
  await textarea.setValue(text);
  await textarea.trigger('keydown', { key: 'Enter' });
  await settle();
}

/** A task starting, as the main process reports it. */
function startTask(conversationId: string, taskId: string) {
  emitIpc(IPC_CHANNELS.CLAUDE_TASK_NOTIFICATION, conversationId, {
    taskId,
    status: 'running',
    description: `task ${taskId}`,
  });
}

describe('background tasks across a conversation switch', () => {
  let conversations: ReturnType<typeof useConversationsStore>;
  let chat: ReturnType<typeof useChatStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    files.clear();
    ipcListeners.clear();

    if (!exposed.api) throw new Error('preload did not expose its API');
    (globalThis as unknown as { window: Record<string, unknown> }).window.electron = exposed.api;

    conversationService = new ConversationService();
    storedConfig = { workingDirectory: '/home/user/project', apiKey: 'test-key' };

    conversations = useConversationsStore();
    chat = useChatStore();

    const settings = useSettingsStore();
    settings.config.workingDirectory = '/home/user/project';
    settings.config.apiKey = 'test-key';

    await conversations.loadConversationList();
    await settle();
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
  });

  /** Two conversations, a turn with a running task in the first. */
  async function twoConversationsWithATaskInTheFirst(wrapper: ReturnType<typeof mount>) {
    const other = conversations.createNewConversation();
    await send(wrapper, 'unrelated');
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, other);
    await settle();

    const withTask = conversations.createNewConversation();
    await send(wrapper, 'please run something in the background');
    startTask(withTask, 'task-1');
    await settle();

    return { withTask, other };
  }

  it('shows a running task in the conversation that owns it', async () => {
    const wrapper = mountApp();
    await twoConversationsWithATaskInTheFirst(wrapper);

    expect(chat.runningBackgroundTasksList.map((t) => t.id)).toEqual(['task-1']);
  });

  it('does not show one conversation s tasks in another', async () => {
    const wrapper = mountApp();
    const { other } = await twoConversationsWithATaskInTheFirst(wrapper);

    await conversations.switchConversation(other);
    await settle();

    expect(chat.runningBackgroundTasksList).toHaveLength(0);
  });

  it('still shows the task after switching away and back', async () => {
    // The report: the list goes missing after a switch.
    const wrapper = mountApp();
    const { withTask, other } = await twoConversationsWithATaskInTheFirst(wrapper);

    await conversations.switchConversation(other);
    await settle();
    await conversations.switchConversation(withTask);
    await settle();

    expect(chat.runningBackgroundTasksList.map((t) => t.id)).toEqual(['task-1']);
  });

  it('keeps the task running through a switch, not merely present', async () => {
    const wrapper = mountApp();
    const { withTask, other } = await twoConversationsWithATaskInTheFirst(wrapper);

    await conversations.switchConversation(other);
    await settle();
    await conversations.switchConversation(withTask);
    await settle();

    const task = chat.backgroundTasks.get('task-1');
    expect(task?.status).toBe('running');
  });

  it('keeps the inline task row in the transcript across a switch', async () => {
    // The panel and the transcript are separate renderings of the same task.
    const wrapper = mountApp();
    const { withTask, other } = await twoConversationsWithATaskInTheFirst(wrapper);

    await conversations.switchConversation(other);
    await settle();
    await conversations.switchConversation(withTask);
    await settle();

    expect(chat.messages.some((m) => m.backgroundTask?.taskId === 'task-1')).toBe(true);
  });

  it('retires a running task the session no longer lists', async () => {
    // `background_tasks_changed` carries REPLACE semantics, and is what stops
    // a finished task sitting in the panel forever.
    const wrapper = mountApp();
    const { withTask } = await twoConversationsWithATaskInTheFirst(wrapper);

    emitIpc(IPC_CHANNELS.CLAUDE_BACKGROUND_TASKS_CHANGED, withTask, []);
    await settle();

    expect(chat.runningBackgroundTasksList).toHaveLength(0);
    expect(chat.backgroundTasks.get('task-1')?.status).toBe('stopped');
  });

  it('does not retire a task because another conversation has none', async () => {
    // Each conversation's session reports its own set. A live list arriving
    // for one must not touch another's tasks.
    const wrapper = mountApp();
    const { withTask, other } = await twoConversationsWithATaskInTheFirst(wrapper);

    emitIpc(IPC_CHANNELS.CLAUDE_BACKGROUND_TASKS_CHANGED, other, []);
    await settle();

    await conversations.switchConversation(withTask);
    await settle();
    expect(chat.runningBackgroundTasksList.map((t) => t.id)).toEqual(['task-1']);
  });

  it('does not retire an unrelated task when an unknown one finishes', async () => {
    // The notification handler falls back to "the oldest running task" when a
    // completion arrives for an id it does not track. With more than one task
    // running, that retires whichever started first — which may still be
    // going — and it vanishes from the panel while actually running.
    const wrapper = mountApp();
    const { withTask } = await twoConversationsWithATaskInTheFirst(wrapper);

    startTask(withTask, 'task-2');
    await settle();
    expect(chat.runningBackgroundTasksList).toHaveLength(2);

    // A completion for something this conversation never tracked.
    emitIpc(IPC_CHANNELS.CLAUDE_TASK_NOTIFICATION, withTask, {
      taskId: 'task-from-elsewhere',
      status: 'completed',
      description: 'nothing we have seen',
      summary: 'done',
    });
    await settle();

    expect(chat.runningBackgroundTasksList.map((t) => t.id).sort()).toEqual([
      'task-1',
      'task-2',
    ]);
  });

  it('still retires the one running task when an unknown completion arrives', async () => {
    // The case the fallback exists for: the id remapping did not reach the
    // renderer, so the completion names a task we never saw. With exactly one
    // running there is no ambiguity, and without this it would sit in the
    // panel marked running forever.
    const wrapper = mountApp();
    const { withTask } = await twoConversationsWithATaskInTheFirst(wrapper);

    emitIpc(IPC_CHANNELS.CLAUDE_TASK_NOTIFICATION, withTask, {
      taskId: 'remapped-id-we-never-saw',
      status: 'completed',
      description: 'something else entirely',
      summary: 'done',
    });
    await settle();

    expect(chat.runningBackgroundTasksList).toHaveLength(0);
  });

  it('loses running tasks across a restart, because they are not persisted', async () => {
    // Documents what is NOT kept: the task map is in-memory only, so a task
    // still running when the app is closed is not in the panel on reopening,
    // even though its row is in the transcript. Asserted so the day it is
    // persisted, this says so rather than quietly passing.
    const wrapper = mountApp();
    const { withTask } = await twoConversationsWithATaskInTheFirst(wrapper);
    emitIpc(IPC_CHANNELS.CLAUDE_DONE, withTask);
    await settle();

    mounted?.unmount();
    mounted = null;
    setActivePinia(createPinia());
    const reloaded = useConversationsStore();
    const reloadedChat = useChatStore();
    useSettingsStore().config.workingDirectory = '/home/user/project';

    await reloaded.loadConversationList();
    await reloaded.loadConversation(withTask);
    await settle();

    expect(reloadedChat.runningBackgroundTasksList).toHaveLength(0);
    // The transcript still records that it happened.
    expect(reloadedChat.messages.some((m) => m.backgroundTask?.taskId === 'task-1')).toBe(true);
  });
});
