/**
 * Integration test for the turn spinner, at the layer that actually renders it.
 *
 * Previous attempts at this bug were "verified" against the chat store in
 * isolation, asserting the invariants the fix had just introduced. That never
 * exercised showTurnSpinner(), which is what puts the spinner on screen, and
 * never exercised the real IPC handlers in useClaudeChat that drive the store.
 * It passed while the app stayed broken.
 *
 * This mounts a host component that calls useClaudeChat() — so its onMounted
 * registers the genuine listeners — renders the real MessageList against the
 * real store, then fires the IPC callbacks the main process actually sends and
 * asserts on the spinner element in the DOM.
 */

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';

import { useClaudeChat } from '../../../composables/useClaudeChat';
import { useChatStore } from '../../../stores/chat';
import { useConversationsStore } from '../../../stores/conversations';
import MessageList from '../MessageList.vue';

const CONV = 'conv-spinner-1';
const SPINNER = '.assistant-turn-trailing-spinner';

/** Captured IPC callbacks, keyed by the `on*` name useClaudeChat subscribes to. */
type Cb = (...args: unknown[]) => void;
let cbs: Record<string, Cb>;

function capture(name: string) {
  return (cb: Cb) => {
    cbs[name] = cb;
    return () => {};
  };
}

function installElectronMock() {
  cbs = {};
  (globalThis as unknown as { window: Record<string, unknown> }).window.electron = {
    claude: {
      send: vi.fn().mockResolvedValue(undefined),
      approve: vi.fn(),
      reject: vi.fn(),
      abort: vi.fn().mockResolvedValue(undefined),
      getCommands: vi.fn().mockResolvedValue([]),
      getModels: vi.fn().mockResolvedValue([]),
      getActiveQueries: vi.fn().mockResolvedValue(0),
      onChunk: capture('chunk'),
      onToolUse: capture('toolUse'),
      onError: capture('error'),
      onDone: capture('done'),
      onSlashCommands: capture('slashCommands'),
      onCommandAction: capture('commandAction'),
      onTaskNotification: capture('taskNotification'),
      onUsageUpdate: capture('usageUpdate'),
      onActiveQueriesChange: capture('activeQueries'),
      onActiveModel: capture('activeModel'),
      onSubagentActivity: capture('subagentActivity'),
      onModelsChanged: capture('modelsChanged'),
      onSessionId: capture('sessionId'),
      onToolCapture: capture('toolCapture'),
      onToolResult: capture('toolResult'),
      onToolExecuted: capture('toolExecuted'),
      onSystemNote: capture('systemNote'),
      onSessionPermissionsChanged: capture('sessionPermissionsChanged'),
      answerQuestion: vi.fn(),
      revokeSessionPermission: vi.fn(),
    },
    auth: { onInvalidated: capture('authInvalidated') },
    conversation: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(),
      rename: vi.fn(),
    },
    config: { get: vi.fn().mockResolvedValue({}), set: vi.fn(), onChange: () => () => {} },
    files: { getTree: vi.fn().mockResolvedValue([]), onFileChange: () => () => {}, watch: vi.fn(), unwatch: vi.fn() },
  } as never;
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
  // Guard against the failure mode that produced a false reproduction of this
  // very bug: an incomplete electron mock throws during onMounted, the tree
  // stops re-rendering, and find() keeps returning the last good DOM — a
  // permanently "stuck" spinner that is entirely an artifact of the harness.
  if (Object.keys(cbs).length < 12) {
    throw new Error(
      `electron mock is incomplete — only ${Object.keys(cbs).length} listeners registered: ${Object.keys(cbs).join(', ')}`,
    );
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
    installElectronMock();
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

    cbs.done?.(CONV);
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

      cbs.done?.(CONV);
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

    cbs.taskNotification?.(CONV, {
      taskId: 'task-1',
      status: 'completed',
      description: 'background agent',
    });
    await settle();

    cbs.done?.(CONV);
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

    cbs.error?.(CONV, 'something failed');
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
