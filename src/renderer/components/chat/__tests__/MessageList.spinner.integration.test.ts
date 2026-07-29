/**
 * Integration test for the turn spinner, at the layer that actually renders it.
 *
 * Previous attempts at this bug were "verified" against the chat store in
 * isolation, asserting the invariants the fix had just introduced. That never
 * exercised showTurnSpinner(), which is what puts the spinner on screen, and
 * never exercised the real IPC handlers in useClaudeChat that drive the store.
 * It passed while the app stayed broken.
 *
 * The bridge under `window.electron` is OUR code (src/preload/preload.ts), so
 * it is not mocked here. A hand-written fake of it drifted from the real API,
 * threw during onMounted, stopped the tree re-rendering and left find()
 * returning stale DOM — a "permanently stuck spinner" that was purely the
 * test's own doing. Only Electron itself is mocked; the real preload builds
 * the API object, so its surface cannot drift from what the app uses.
 */

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';

// vi.mock is hoisted above ordinary declarations, so the shared state the
// factory closes over has to be hoisted with it.
type IpcHandler = (event: unknown, ...args: unknown[]) => void;
const { ipcListeners, exposed } = vi.hoisted(() => ({
  /** Renderer-side IPC listeners, by channel — the external boundary. */
  ipcListeners: new Map<string, ((event: unknown, ...args: unknown[]) => void)[]>(),
  /** Holder for the API object the real preload exposes. */
  exposed: { api: null as Record<string, unknown> | null },
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, unknown>) => {
      exposed.api = api;
    },
  },
  ipcRenderer: {
    // Stands in for the main process. Returning undefined for everything is
    // not a realistic boundary — several call sites expect a list.
    invoke: vi.fn(async (channel: string) => {
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
import { useClaudeChat } from '../../../composables/useClaudeChat';
import { useChatStore } from '../../../stores/chat';
import { useConversationsStore } from '../../../stores/conversations';
import MessageList from '../MessageList.vue';

// Importing the real preload runs exposeInMainWorld and populates `bridge`.
import '../../../../preload/preload';

/** Deliver an IPC event exactly as the main process would. */
function emitIpc(channel: string, ...args: unknown[]) {
  for (const handler of [...(ipcListeners.get(channel) ?? [])]) {
    handler({}, ...args);
  }
}

const CONV = 'conv-spinner-1';
const SPINNER = '.assistant-turn-trailing-spinner';

/** Install the real preload-built API as window.electron. */
function installBridge() {
  ipcListeners.clear();
  if (!exposed.api) throw new Error('preload did not expose its API');
  (globalThis as unknown as { window: Record<string, unknown> }).window.electron = exposed.api;
}

/** Host component: runs the real composable and renders the real list. */
const Host = defineComponent({
  setup() {
    useClaudeChat();
    return () => h(MessageList);
  },
});

let mounted: ReturnType<typeof mount> | null = null;

function mountHost() {
  const wrapper = mount(Host, {
    global: {
      stubs: { MessageItem: true, Icon: true, Spinner: true, MarkdownViewerModal: true },
    },
  });
  // A silent mount failure looks exactly like the bug under test: the tree
  // stops re-rendering and find() keeps returning the last good DOM. Assert
  // the composable really subscribed before trusting any assertion below.
  if (!ipcListeners.has(IPC_CHANNELS.CLAUDE_DONE)) {
    throw new Error('useClaudeChat did not subscribe — mount failed silently');
  }
  mounted = wrapper;
  return wrapper;
}

async function settle() {
  await nextTick();
  await nextTick();
}

describe('turn spinner — real render path', () => {
  let chat: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    installBridge();
    chat = useChatStore();
    useConversationsStore().currentConversationId = CONV;
    chat.currentConversationId = CONV;
  });

  // useClaudeChat registers its IPC listeners once, guarded by module-level
  // singleton state with a ref count. Without unmounting, the second test
  // mounts against a ref count that never reached zero, registers nothing, and
  // its freshly-installed mock captures no callbacks at all.
  afterEach(() => {
    mounted?.unmount();
    mounted = null;
  });

  /** The plain case: user turn starts, streams, and the CLI reports done. */
  it('clears the spinner when the turn completes', async () => {
    const wrapper = mountHost();

    chat.addMessage({ id: 'u1', role: 'user', content: 'hi', timestamp: Date.now() });
    chat.startAssistantMessage(CONV);
    chat.setLoading(CONV, true);
    chat.appendChunk(CONV, 'answer');
    await settle();
    expect(wrapper.find(SPINNER).exists()).toBe(true);

    emitIpc(IPC_CHANNELS.CLAUDE_DONE, CONV);
    await settle();

    expect(wrapper.find(SPINNER).exists()).toBe(false);
  });

  /**
   * The reported symptom: several turns back to back. A turn that ends
   * untidily must not poison the turns after it.
   */
  it('clears the spinner on every one of several consecutive turns', async () => {
    const wrapper = mountHost();

    for (let turn = 0; turn < 4; turn++) {
      chat.addMessage({ id: `u${turn}`, role: 'user', content: 'q', timestamp: Date.now() });
      chat.startAssistantMessage(CONV);
      chat.setLoading(CONV, true);
      chat.appendChunk(CONV, `answer ${turn}`);
      await settle();
      expect(wrapper.find(SPINNER).exists()).toBe(true);

      emitIpc(IPC_CHANNELS.CLAUDE_DONE, CONV);
      await settle();
      expect(
        wrapper.find(SPINNER).exists(),
        `spinner still present after turn ${turn}`,
      ).toBe(false);
    }
  });

  /** A background agent finishing must not leave the spinner behind either. */
  it('clears the spinner when a background task completed during the turn', async () => {
    const wrapper = mountHost();

    chat.addMessage({ id: 'u1', role: 'user', content: 'spawn an agent', timestamp: Date.now() });
    chat.startAssistantMessage(CONV);
    chat.setLoading(CONV, true);
    chat.appendChunk(CONV, 'starting');

    emitIpc(IPC_CHANNELS.CLAUDE_TASK_NOTIFICATION, CONV, {
      taskId: 'task-1',
      status: 'completed',
      description: 'background agent',
    });
    await settle();

    emitIpc(IPC_CHANNELS.CLAUDE_DONE, CONV);
    await settle();

    expect(wrapper.find(SPINNER).exists()).toBe(false);
  });

  /** An error ends the turn too — the spinner must not survive it. */
  it('clears the spinner when the turn ends in an error', async () => {
    const wrapper = mountHost();

    chat.addMessage({ id: 'u1', role: 'user', content: 'hi', timestamp: Date.now() });
    chat.startAssistantMessage(CONV);
    chat.setLoading(CONV, true);
    await settle();

    emitIpc(IPC_CHANNELS.CLAUDE_ERROR, CONV, 'something failed');
    await settle();

    expect(wrapper.find(SPINNER).exists()).toBe(false);
  });

  /** Aborting must clear it as well. */
  it('clears the spinner after an abort', async () => {
    const wrapper = mountHost();

    chat.addMessage({ id: 'u1', role: 'user', content: 'hi', timestamp: Date.now() });
    chat.startAssistantMessage(CONV);
    chat.setLoading(CONV, true);
    chat.appendChunk(CONV, 'partial');
    await settle();

    chat.setLoading(CONV, false);
    chat.finishStreaming(CONV);
    await settle();

    expect(wrapper.find(SPINNER).exists()).toBe(false);
  });
});
