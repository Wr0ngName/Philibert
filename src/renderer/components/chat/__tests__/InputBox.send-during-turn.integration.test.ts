/**
 * Sending a prompt into the turn that is running, through the real path.
 *
 * During a turn the input offers two things, as Stop does: Send puts the
 * prompt into the running turn, which Claude reads at its next step; Queue
 * holds it for after the turn. The main process reports when Claude read it
 * (CLAUDE_PROMPT_DELIVERY 'started'), and that is when it joins the
 * discussion, between what Claude wrote before and its answer — or, should
 * the session end first ('cancelled'), it goes back to the queue.
 *
 * Only Electron is mocked: `window.electron` is our own preload, as in
 * InputBox.queue.integration.test.ts.
 */

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';

type IpcHandler = (event: unknown, ...args: unknown[]) => void;
const { ipcListeners, exposed, invoked, duringTurn } = vi.hoisted(() => ({
  ipcListeners: new Map<string, ((event: unknown, ...args: unknown[]) => void)[]>(),
  exposed: { api: null as Record<string, unknown> | null },
  invoked: [] as { channel: string; args: unknown[] }[],
  /** What the main process answers a send into the turn with: its uuid, or null. */
  duringTurn: { answer: 'uuid-1' as string | null, takenBack: true },
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, unknown>) => {
      exposed.api = api;
    },
  },
  ipcRenderer: {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
      invoked.push({ channel, args: structuredClone(args) });
      if (channel === 'claude:send-during-turn') return duringTurn.answer;
      if (channel === 'claude:cancel-during-turn') return duringTurn.takenBack;
      if (/availability/i.test(channel)) return { available: false };
      if (/commands|models|list|queries|permissions/i.test(channel)) return [];
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
import { useFilesStore } from '../../../stores/files';
import { useSettingsStore } from '../../../stores/settings';
import ChatWindow from '../ChatWindow.vue';

import '../../../../preload/preload';

const CONV = 'conv-send-during-turn';

function emitIpc(channel: string, ...args: unknown[]) {
  for (const handler of [...(ipcListeners.get(channel) ?? [])]) handler({}, ...args);
}

function invokes(channel: string): unknown[][] {
  return invoked.filter((call) => call.channel === channel).map((call) => call.args);
}

let mounted: ReturnType<typeof mount> | null = null;

function mountHost() {
  const wrapper = mount(ChatWindow);
  if (!ipcListeners.has(IPC_CHANNELS.CLAUDE_PROMPT_DELIVERY)) {
    throw new Error('useClaudeChat did not subscribe — mount failed silently');
  }
  mounted = wrapper;
  return wrapper;
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 6; i += 1) await nextTick();
}

async function type(wrapper: ReturnType<typeof mount>, text: string, key: { ctrlKey?: boolean } = {}) {
  const textarea = wrapper.find('textarea');
  await textarea.setValue(text);
  await textarea.trigger('keydown', { key: 'Enter', ...key });
  await settle();
}

function button(wrapper: ReturnType<typeof mount>, label: string) {
  const found = wrapper.findAll('button').find((b) => b.text() === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

/** The discussion as role:content, streaming placeholders left out. */
function discussion(chat: ReturnType<typeof useChatStore>): string[] {
  return chat.messages.filter((m) => m.content).map((m) => `${m.role}:${m.content}`);
}

describe('sending a prompt into the running turn', () => {
  let chat: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    ipcListeners.clear();
    invoked.length = 0;
    duringTurn.answer = 'uuid-1';
    duringTurn.takenBack = true;
    if (!exposed.api) throw new Error('preload did not expose its API');
    (globalThis as unknown as { window: Record<string, unknown> }).window.electron = exposed.api;

    chat = useChatStore();
    chat.currentConversationId = CONV;
    useConversationsStore().currentConversationId = CONV;
    const settings = useSettingsStore();
    settings.config.apiKey = 'test-key';
    settings.config.workingDirectory = '/tmp/project';
    if (!useFilesStore().hasWorkingDirectory) throw new Error('no working directory');
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
  });

  /** A turn in progress, with some text already streamed. */
  async function turnRunning(wrapper: ReturnType<typeof mount>) {
    await type(wrapper, 'build the app');
    emitIpc(IPC_CHANNELS.CLAUDE_CHUNK, CONV, 'Building now.');
    await settle();
  }

  it('offers Send and Queue during a turn, both labelled', async () => {
    const wrapper = mountHost();
    await turnRunning(wrapper);

    expect(button(wrapper, 'Send').exists()).toBe(true);
    expect(button(wrapper, 'Queue').exists()).toBe(true);
  });

  it('sends into the turn on Enter, and lists it until Claude reads it', async () => {
    const wrapper = mountHost();
    await turnRunning(wrapper);

    await type(wrapper, 'also run the tests');

    expect(invokes(IPC_CHANNELS.CLAUDE_SEND_DURING_TURN)).toEqual([[CONV, 'also run the tests', undefined]]);
    expect(invokes(IPC_CHANNELS.CLAUDE_SEND).map((args) => args[1])).toEqual(['build the app']);
    expect(chat.queuedPrompts).toEqual([]);
    expect(wrapper.find('[data-testid="delivering-prompts"]').text()).toContain('also run the tests');
    // Not in the discussion until Claude has read it.
    expect(discussion(chat)).toEqual(['user:build the app', 'assistant:Building now.']);
  });

  it('puts it in the discussion where Claude read it, with the answer after it', async () => {
    const wrapper = mountHost();
    await turnRunning(wrapper);
    await wrapper.find('textarea').setValue('also run the tests');
    await button(wrapper, 'Send').trigger('click');
    await settle();

    emitIpc(IPC_CHANNELS.CLAUDE_PROMPT_DELIVERY, CONV, 'uuid-1', 'started');
    emitIpc(IPC_CHANNELS.CLAUDE_CHUNK, CONV, 'Running the tests too.');
    await settle();

    expect(discussion(chat)).toEqual([
      'user:build the app',
      'assistant:Building now.',
      'user:also run the tests',
      'assistant:Running the tests too.',
    ]);
    expect(wrapper.find('[data-testid="delivering-prompts"]').exists()).toBe(false);
  });

  it('gives it back to the queue when Claude never reads it, and sends it after the turn', async () => {
    const wrapper = mountHost();
    await turnRunning(wrapper);
    await type(wrapper, 'also run the tests');

    emitIpc(IPC_CHANNELS.CLAUDE_PROMPT_DELIVERY, CONV, 'uuid-1', 'cancelled');
    await settle();

    expect(chat.queuedPrompts.map((p) => p.content)).toEqual(['also run the tests']);
    expect(wrapper.find('[data-testid="delivering-prompts"]').exists()).toBe(false);

    emitIpc(IPC_CHANNELS.CLAUDE_DONE, CONV);
    await settle();
    expect(invokes(IPC_CHANNELS.CLAUDE_SEND).map((args) => args[1])).toEqual(['build the app', 'also run the tests']);
  });

  it('queues on the Queue button and on Ctrl+Enter, sending nothing into the turn', async () => {
    const wrapper = mountHost();
    await turnRunning(wrapper);

    await wrapper.find('textarea').setValue('after this turn');
    await button(wrapper, 'Queue').trigger('click');
    await type(wrapper, 'and this too', { ctrlKey: true });

    expect(invokes(IPC_CHANNELS.CLAUDE_SEND_DURING_TURN)).toEqual([]);
    expect(chat.queuedPrompts.map((p) => p.content)).toEqual(['after this turn', 'and this too']);
  });

  it('sends it the ordinary way when the turn ended as it was sent', async () => {
    const wrapper = mountHost();
    await turnRunning(wrapper);
    duringTurn.answer = null;

    await type(wrapper, 'also run the tests');

    expect(invokes(IPC_CHANNELS.CLAUDE_SEND).map((args) => args[1])).toEqual(['build the app', 'also run the tests']);
    expect(wrapper.find('[data-testid="delivering-prompts"]').exists()).toBe(false);
  });

  it('takes it back before Claude reads it: gone, and not queued either', async () => {
    const wrapper = mountHost();
    await turnRunning(wrapper);
    await type(wrapper, 'also run the tests');

    await wrapper.find('[title="Take this back before Claude reads it"]').trigger('click');
    await settle();

    expect(invokes(IPC_CHANNELS.CLAUDE_CANCEL_DURING_TURN)).toEqual([[CONV, 'uuid-1']]);
    expect(wrapper.find('[data-testid="delivering-prompts"]').exists()).toBe(false);
    expect(chat.queuedPrompts).toEqual([]);
    expect(discussion(chat)).toEqual(['user:build the app', 'assistant:Building now.']);
  });

  it('says so when it is too late, and the prompt still joins the discussion', async () => {
    const wrapper = mountHost();
    await turnRunning(wrapper);
    await type(wrapper, 'also run the tests');
    duringTurn.takenBack = false;

    await wrapper.find('[title="Take this back before Claude reads it"]').trigger('click');
    await settle();
    expect(wrapper.find('[data-testid="delivering-prompts"]').text()).toContain('Claude already has it');

    emitIpc(IPC_CHANNELS.CLAUDE_PROMPT_DELIVERY, CONV, 'uuid-1', 'started');
    await settle();
    expect(discussion(chat)).toContain('user:also run the tests');
  });

  it('queues a slash command rather than putting it into another turn', async () => {
    const wrapper = mountHost();
    await turnRunning(wrapper);

    await type(wrapper, '/compact');

    expect(invokes(IPC_CHANNELS.CLAUDE_SEND_DURING_TURN)).toEqual([]);
    expect(chat.queuedPrompts.map((p) => p.content)).toEqual(['/compact']);
  });
});
