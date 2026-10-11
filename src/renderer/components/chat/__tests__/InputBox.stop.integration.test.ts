/**
 * What Stop stops.
 *
 * Stop interrupts the turn and deliberately leaves background agents and
 * workflows running — the SDK side of that is one option, asserted in
 * ClaudeCodeService.test.ts. This is the other half: that a plain Stop asks
 * for nothing but the interrupt, and that there is a way to take the rest down
 * on purpose, since a spared task the user cannot kill is worse than one that
 * died with the turn.
 *
 * Only Electron is mocked; `window.electron` is built by the real preload and
 * the whole component tree is real.
 */

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';

type IpcHandler = (event: unknown, ...args: unknown[]) => void;
const { ipcListeners, exposed, invoked } = vi.hoisted(() => ({
  ipcListeners: new Map<string, ((event: unknown, ...args: unknown[]) => void)[]>(),
  exposed: { api: null as Record<string, unknown> | null },
  invoked: [] as { channel: string; args: unknown[] }[],
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, unknown>) => {
      exposed.api = api;
    },
  },
  ipcRenderer: {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
      invoked.push({ channel, args });
      if (typeof channel === 'string' && /availability/i.test(channel)) {
        return { available: false };
      }
      if (typeof channel === 'string' && /commands|models|list|queries|permissions/i.test(channel)) {
        return [];
      }
      return undefined;
    }),
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

import { IPC_CHANNELS } from '../../../../shared/types';
import { useChatStore } from '../../../stores/chat';
import { useConversationsStore } from '../../../stores/conversations';
import { useSettingsStore } from '../../../stores/settings';
import ChatWindow from '../ChatWindow.vue';

import '../../../../preload/preload';

const CONV = 'conv-stop-1';

function emitIpc(channel: string, ...args: unknown[]) {
  for (const handler of [...(ipcListeners.get(channel) ?? [])]) {
    handler({}, ...args);
  }
}

function installBridge() {
  ipcListeners.clear();
  invoked.length = 0;
  if (!exposed.api) throw new Error('preload did not expose its API');
  (globalThis as unknown as { window: Record<string, unknown> }).window.electron = exposed.api;
}

/** Channels asked for, so "what did Stop stop" can be read off directly. */
function calls(channel: string) {
  return invoked.filter((call) => call.channel === channel);
}

let mounted: ReturnType<typeof mount> | null = null;

function mountChat() {
  const wrapper = mount(ChatWindow);
  if (!ipcListeners.has(IPC_CHANNELS.CLAUDE_DONE)) {
    throw new Error('useClaudeChat did not subscribe — mount failed silently');
  }
  mounted = wrapper;
  return wrapper;
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await nextTick();
}

/**
 * Start a background task the way the app learns about one: a task
 * notification from the main process. Poking the store directly would skip
 * the handler that decides what ends up in the running list.
 */
function startTask(id: string) {
  emitIpc(IPC_CHANNELS.CLAUDE_TASK_NOTIFICATION, CONV, {
    taskId: id,
    status: 'running',
    description: `task ${id}`,
  });
}

/** Report a task as finished, through the same path. */
function finishTask(id: string) {
  emitIpc(IPC_CHANNELS.CLAUDE_TASK_NOTIFICATION, CONV, {
    taskId: id,
    status: 'completed',
    description: `task ${id}`,
    summary: 'done',
  });
}

function findButton(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').find((b) => b.text().includes(text));
}

function findByTitle(wrapper: ReturnType<typeof mount>, title: string) {
  return wrapper.findAll('button').find((b) => b.attributes('title')?.includes(title));
}

/**
 * The open menu's items.
 *
 * ContextMenu teleports to the body, so its buttons are not inside the mounted
 * wrapper and `wrapper.find` cannot see them — they are queried from the
 * document and clicked natively, which is what the user's click does anyway.
 */
function menuItems(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
}

function menuText(): string {
  return menuItems()
    .map((item) => item.textContent ?? '')
    .join(' | ');
}

async function clickMenuItem(text: string): Promise<void> {
  const item = menuItems().find((b) => (b.textContent ?? '').includes(text));
  if (!item) throw new Error(`no menu item matching "${text}" in: ${menuText()}`);
  item.click();
  await settle();
}

describe('what Stop stops', () => {
  let chat: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    installBridge();

    chat = useChatStore();
    chat.currentConversationId = CONV;
    useConversationsStore().currentConversationId = CONV;

    const settings = useSettingsStore();
    settings.config.apiKey = 'test-key';
    settings.config.workingDirectory = '/tmp/project';
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
  });

  it('asks only for an interrupt, leaving background tasks alone', async () => {
    // The reported behaviour was Stop "killing agents and everything on its
    // way". The renderer's part of the fix is to ask for nothing more than the
    // interrupt; the CLI spares the tasks because of the declaration made in
    // ClaudeCodeService.
    const wrapper = mountChat();
    chat.setLoading(CONV, true);
    startTask('task-1');
    startTask('task-2');
    await settle();

    await findButton(wrapper, 'Stop')!.trigger('click');
    await settle();

    expect(calls(IPC_CHANNELS.CLAUDE_ABORT)).toHaveLength(1);
    expect(calls(IPC_CHANNELS.CLAUDE_STOP_TASK)).toHaveLength(0);
  });

  it('offers more ways to stop only when something else is running', async () => {
    // With nothing else running the two menu items would mean the same thing.
    const wrapper = mountChat();
    chat.setLoading(CONV, true);
    await settle();

    expect(findByTitle(wrapper, 'More ways to stop')).toBeUndefined();

    startTask('task-1');
    await settle();

    expect(findByTitle(wrapper, 'More ways to stop')).toBeDefined();
  });

  it('stops every running task as well, when asked to', async () => {
    const wrapper = mountChat();
    chat.setLoading(CONV, true);
    startTask('task-1');
    startTask('task-2');
    await settle();

    await findByTitle(wrapper, 'More ways to stop')!.trigger('click');
    await settle();

    await clickMenuItem('background tasks');

    const stopped = calls(IPC_CHANNELS.CLAUDE_STOP_TASK).map((call) => call.args[1]);
    expect(stopped.sort()).toEqual(['task-1', 'task-2']);
    expect(calls(IPC_CHANNELS.CLAUDE_ABORT)).toHaveLength(1);
  });

  it('leaves tasks that already finished alone', async () => {
    const wrapper = mountChat();
    chat.setLoading(CONV, true);
    startTask('still-going');
    startTask('already-done');
    finishTask('already-done');
    await settle();

    await findByTitle(wrapper, 'More ways to stop')!.trigger('click');
    await settle();
    await clickMenuItem('background task');

    const stopped = calls(IPC_CHANNELS.CLAUDE_STOP_TASK).map((call) => call.args[1]);
    expect(stopped).toEqual(['still-going']);
  });

  it('counts the tasks it is about to stop, in the singular too', async () => {
    const wrapper = mountChat();
    chat.setLoading(CONV, true);
    startTask('only-one');
    await settle();

    await findByTitle(wrapper, 'More ways to stop')!.trigger('click');
    await settle();

    expect(menuText()).toContain('Stop this turn and 1 background task');
    expect(menuText()).not.toContain('1 background tasks');
  });

  it('still interrupts the turn when a task refuses to stop', async () => {
    // One task that cannot be stopped must not spare the others or the turn.
    const wrapper = mountChat();
    chat.setLoading(CONV, true);
    startTask('stubborn');
    startTask('fine');
    await settle();

    const ipc = (await import('electron')).ipcRenderer.invoke as ReturnType<typeof vi.fn>;
    ipc.mockImplementationOnce(async (channel: string, ...args: unknown[]) => {
      invoked.push({ channel, args });
      throw new Error('that task cannot be stopped');
    });

    await findByTitle(wrapper, 'More ways to stop')!.trigger('click');
    await settle();
    await clickMenuItem('background tasks');

    expect(calls(IPC_CHANNELS.CLAUDE_STOP_TASK)).toHaveLength(2);
    expect(calls(IPC_CHANNELS.CLAUDE_ABORT)).toHaveLength(1);
  });

  it('keeps the caret part of the Stop button rather than beside it', async () => {
    // Two buttons with a gap between them read as two controls, one of which
    // happens to sit nearby. The caret is a second way to press Stop, so it
    // belongs inside the same control; the scoped CSS squares the inner
    // corners and draws a seam, which is only coherent if they really are
    // siblings in one container.
    const wrapper = mountChat();
    chat.setLoading(CONV, true);
    startTask('task-1');
    await settle();

    const split = wrapper.find('.split-control');
    expect(split.exists()).toBe(true);
    expect(split.findAll('button')).toHaveLength(2);
    expect(split.findAll('button')[1].attributes('title')).toContain('More ways to stop');
  });

  it('offers a way to stop background work once the turn has ended', async () => {
    // The hole this opened: Stop spares running agents and tasks, so they
    // outlive the turn — and the Stop control went away with the turn, leaving
    // Send as the only button while agents were still working. They were
    // reachable only one at a time through each task's detail modal.
    const wrapper = mountChat();
    startTask('task-1');
    startTask('task-2');
    await settle();

    const stopTasks = findButton(wrapper, 'Stop 2 tasks');
    expect(stopTasks).toBeDefined();

    await stopTasks!.trigger('click');
    await settle();

    const stopped = calls(IPC_CHANNELS.CLAUDE_STOP_TASK).map((call) => call.args[1]);
    expect(stopped.sort()).toEqual(['task-1', 'task-2']);
    // Nothing to interrupt, so nothing should be asked of the turn.
    expect(calls(IPC_CHANNELS.CLAUDE_ABORT)).toHaveLength(0);
  });

  it('counts a single idle task in the singular', async () => {
    const wrapper = mountChat();
    startTask('only-one');
    await settle();

    expect(findButton(wrapper, 'Stop 1 task')).toBeDefined();
    expect(findButton(wrapper, 'Stop 1 tasks')).toBeUndefined();
  });

  it('offers nothing to stop when the turn has ended and the tasks with it', async () => {
    const wrapper = mountChat();
    startTask('task-1');
    finishTask('task-1');
    await settle();

    expect(findButton(wrapper, 'Stop')).toBeUndefined();
  });

  it('drops the idle stop control once the tasks finish', async () => {
    // The count is live, so it has to disappear rather than offering to stop
    // something that already stopped.
    const wrapper = mountChat();
    startTask('task-1');
    await settle();
    expect(findButton(wrapper, 'Stop 1 task')).toBeDefined();

    finishTask('task-1');
    await settle();

    expect(findButton(wrapper, 'Stop')).toBeUndefined();
  });
});
