/**
 * Queueing a prompt during a running turn, through the real path.
 *
 * The point of testing it here rather than against the store is that the
 * behaviour spans three pieces that each looked fine alone: the input decides
 * whether Enter sends or queues, the store holds the queue, and an IPC event
 * from the main process is what releases it. The defect this replaces was
 * entirely in the seam — there was no way to submit mid-turn at all, because
 * the Send button was swapped for Stop.
 *
 * Only Electron is mocked. `window.electron` is built by our own preload, so
 * a hand-written fake would be free to drift from the API the app calls — see
 * the note in MessageList.spinner.integration.test.ts.
 */

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';

type IpcHandler = (event: unknown, ...args: unknown[]) => void;
const { ipcListeners, exposed, invoked } = vi.hoisted(() => ({
  ipcListeners: new Map<string, ((event: unknown, ...args: unknown[]) => void)[]>(),
  exposed: { api: null as Record<string, unknown> | null },
  /** Every invoke the renderer made, so sends can be asserted on. */
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
      // Copied as Electron copies them, which throws on what it cannot copy.
      invoked.push({ channel, args: structuredClone(args) });
      if (typeof channel === 'string' && /availability/i.test(channel)) {
        // The input asks whether dictation is available during setup and
        // reads `.available` off the answer, so undefined throws.
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
import { useFilesStore } from '../../../stores/files';
import { useSettingsStore } from '../../../stores/settings';
import ChatWindow from '../ChatWindow.vue';

// Importing the real preload runs exposeInMainWorld and populates `exposed`.
import '../../../../preload/preload';

const CONV = 'conv-queue-1';

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

/** Prompts actually sent to Claude, in order. */
function sentPrompts(): string[] {
  return invoked
    .filter((call) => call.channel === IPC_CHANNELS.CLAUDE_SEND)
    .map((call) => String(call.args[1]));
}

let mounted: ReturnType<typeof mount> | null = null;

/**
 * Mount the real ChatWindow, with nothing internal stubbed.
 *
 * The whole seam is the point: the input decides whether Enter sends or
 * queues, ChatWindow binds that to the composable, the store holds the queue,
 * and an IPC event releases it. A purpose-built host that rendered the input
 * without binding its events passed every "nothing was sent" assertion for the
 * wrong reason — which is what the first version of this file did.
 *
 * Only Electron is mocked. Nothing of ours is.
 */
function mountHost() {
  const wrapper = mount(ChatWindow);
  // A silent mount failure looks like a passing test here: no listeners, no
  // sends, and every "nothing was sent" assertion holds for the wrong reason.
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
 * Type a prompt and press Ctrl+Enter, as the user does to queue: it sends
 * when no turn is running and queues during one. (Enter during a turn sends
 * into it instead — see InputBox.send-during-turn.integration.test.ts.)
 */
async function submit(wrapper: ReturnType<typeof mount>, text: string) {
  const textarea = wrapper.find('textarea');
  await textarea.setValue(text);
  await textarea.trigger('keydown', { key: 'Enter', ctrlKey: true });
  await settle();
}

describe('queueing prompts during a turn', () => {
  let chat: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    installBridge();

    chat = useChatStore();
    chat.currentConversationId = CONV;
    useConversationsStore().currentConversationId = CONV;

    // Prerequisites for sending at all; without them every submit is refused
    // and the test would prove nothing. Both live on the settings config —
    // the files store's workingDirectory is a computed over it, so assigning
    // to that one silently does nothing.
    const settings = useSettingsStore();
    settings.config.apiKey = 'test-key';
    settings.config.workingDirectory = '/tmp/project';
    if (!useFilesStore().hasWorkingDirectory) {
      throw new Error('test setup did not establish a working directory');
    }
  });

  afterEach(() => {
    // useClaudeChat registers its listeners once behind a ref count, so
    // skipping this leaves the next test subscribed to nothing.
    mounted?.unmount();
    mounted = null;
  });

  it('sends immediately when no turn is running', async () => {
    const wrapper = mountHost();

    await submit(wrapper, 'first question');

    expect(sentPrompts()).toEqual(['first question']);
    expect(chat.queuedPrompts).toHaveLength(0);
  });

  it('queues instead of sending while a turn is running', async () => {
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();

    await submit(wrapper, 'while you work on that');

    expect(sentPrompts()).toEqual([]);
    expect(chat.queuedPrompts.map((p) => p.content)).toEqual(['while you work on that']);
  });

  it('offers Queue rather than hiding the submit button mid-turn', async () => {
    // The reported problem: during a turn the only button was Stop, so saying
    // the next thing meant killing the run and its agents.
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();

    const labels = wrapper.findAll('button').map((b) => b.text());
    expect(labels.some((label) => label.includes('Queue'))).toBe(true);
    expect(labels.some((label) => label.includes('Stop'))).toBe(true);
  });

  it('clears the textarea when a prompt is queued', async () => {
    // Otherwise the user cannot tell a queued prompt from an unsent draft.
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();

    await submit(wrapper, 'queued text');

    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('');
  });

  it('sends the queued prompt when the turn finishes', async () => {
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();
    await submit(wrapper, 'the follow-up');

    emitIpc(IPC_CHANNELS.CLAUDE_DONE, CONV);
    await settle();

    expect(sentPrompts()).toEqual(['the follow-up']);
    expect(chat.queuedPrompts).toHaveLength(0);
  });

  it('sends only one queued prompt per turn, in order', async () => {
    // Two turns must not start at once, and the order the user wrote them in
    // is the order they meant.
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();
    await submit(wrapper, 'first');
    await submit(wrapper, 'second');

    emitIpc(IPC_CHANNELS.CLAUDE_DONE, CONV);
    await settle();

    expect(sentPrompts()).toEqual(['first']);
    expect(chat.queuedPrompts.map((p) => p.content)).toEqual(['second']);
  });

  it('keeps the queue when the turn ends in an error', async () => {
    // The prompt was written expecting the turn before it to have worked.
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();
    await submit(wrapper, 'next step');

    emitIpc(IPC_CHANNELS.CLAUDE_ERROR, CONV, 'something broke');
    await settle();

    expect(sentPrompts()).toEqual([]);
    expect(chat.queuedPrompts.map((p) => p.content)).toEqual(['next step']);
  });

  it('keeps the queue when the user stops the turn', async () => {
    // Stop is a request for the app to stop working, so it must not
    // immediately start the next prompt. The queue stays, visible, with a
    // "Send now" button for when the user does want it.
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();
    await submit(wrapper, 'after you stop');

    await wrapper.findAll('button').find((b) => b.text().includes('Stop'))!.trigger('click');
    await settle();

    expect(sentPrompts()).toEqual([]);
    expect(chat.queuedPrompts).toHaveLength(1);
  });

  it('releases the queue as soon as nothing is running', async () => {
    // No button required and no event either: the conditions changed, so the
    // queue is re-examined. This is what stops a prompt stranding when the
    // turn it was waiting on ended somewhere the handler could not see.
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();
    await submit(wrapper, 'send this when you can');

    chat.setLoading(CONV, false);
    await settle();

    expect(sentPrompts()).toEqual(['send this when you can']);
  });

  it('sends a held queue on request', async () => {
    // The one case that does need the button: the user stopped the turn, so
    // nothing will release the queue on its own.
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();
    await submit(wrapper, 'send this when I say');

    await wrapper.findAll('button').find((b) => b.text().includes('Stop'))!.trigger('click');
    await settle();
    expect(sentPrompts()).toEqual([]);

    const sendNow = wrapper.findAll('button').find((b) => b.text().includes('Send now'));
    expect(sendNow).toBeDefined();
    await sendNow!.trigger('click');
    await settle();

    expect(sentPrompts()).toEqual(['send this when I say']);
  });

  it('does not offer Send now while a turn is running', async () => {
    // It would start a second turn in the same conversation.
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();
    await submit(wrapper, 'queued');

    expect(wrapper.findAll('button').some((b) => b.text().includes('Send now'))).toBe(false);
  });

  it('lists what is queued, so the user can see queueing did something', async () => {
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();
    await submit(wrapper, 'a visible queued prompt');

    expect(wrapper.text()).toContain('a visible queued prompt');
    expect(wrapper.text()).toContain('1 queued');
  });

  it('removes a queued prompt the user discards', async () => {
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();
    await submit(wrapper, 'changed my mind');

    const remove = wrapper.findAll('button').find((b) => b.attributes('title')?.includes('Remove'));
    expect(remove).toBeDefined();
    await remove!.trigger('click');
    await settle();

    expect(chat.queuedPrompts).toHaveLength(0);

    emitIpc(IPC_CHANNELS.CLAUDE_DONE, CONV);
    await settle();
    expect(sentPrompts()).toEqual([]);
  });

  it('sends the queue when the user comes back to the conversation', async () => {
    // Reported as the queue never emptying: "messages stay persisted there
    // forever, nothing happen when end of turn". A turn ending was the only
    // thing that released a prompt, so a queue held for any other reason
    // stayed held — and switching away is enough to cause that. The turn then
    // ends while the user is elsewhere, and returning is not an event the
    // turn-end handler ever sees, so nothing was left to release it.
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();
    await submit(wrapper, 'for the first conversation');

    // Away, turn ends there, then back.
    chat.currentConversationId = 'conv-elsewhere';
    useConversationsStore().currentConversationId = 'conv-elsewhere';
    await settle();

    emitIpc(IPC_CHANNELS.CLAUDE_DONE, CONV);
    await settle();
    expect(sentPrompts()).toEqual([]);

    chat.currentConversationId = CONV;
    useConversationsStore().currentConversationId = CONV;
    await settle();

    expect(sentPrompts()).toEqual(['for the first conversation']);
    expect(chat.getConversationState(CONV).queuedPrompts).toHaveLength(0);
  });

  it('sends the queue when the turn-end event never arrives', async () => {
    // The literal report: "nothing happen when end of turn". A turn can end
    // without the handler hearing about it — a CLAUDE_DONE that is missed or
    // attributed to the wrong conversation leaves the loading flag set, which
    // is the very reason the active-queries set exists as an authoritative
    // correction. The queue used to wait only on the turn-end event, so when
    // that was what went missing, nothing was left to release it.
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();
    await submit(wrapper, 'waiting on a turn that never reports');

    // No CLAUDE_DONE. The main process reports the authoritative set instead,
    // and this conversation is not in it.
    emitIpc(IPC_CHANNELS.CLAUDE_ACTIVE_QUERIES, 0, 5, 0, []);
    await settle();

    expect(sentPrompts()).toEqual(['waiting on a turn that never reports']);
  });

  it('sends the queue when the turn end is attributed to another conversation', async () => {
    // The misattribution case, which looks identical to the user: the turn
    // really has ended, but the event named someone else.
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();
    await submit(wrapper, 'queued here');

    emitIpc(IPC_CHANNELS.CLAUDE_DONE, 'conv-somewhere-else');
    await settle();
    // Still held, correctly: as far as this conversation knows, it is busy.
    expect(sentPrompts()).toEqual([]);

    emitIpc(IPC_CHANNELS.CLAUDE_ACTIVE_QUERIES, 0, 5, 0, []);
    await settle();

    expect(sentPrompts()).toEqual(['queued here']);
  });

  it('does not release the queue by itself after the user stops a turn', async () => {
    // The re-check watches the loading flag, which an abort also clears — so
    // without an explicit hold, stopping a turn would immediately start the
    // next queued prompt, which is the opposite of what Stop means.
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();
    await submit(wrapper, 'after you stop');

    await wrapper.findAll('button').find((b) => b.text().includes('Stop'))!.trigger('click');
    await settle();

    expect(sentPrompts()).toEqual([]);
    expect(chat.queuedPrompts).toHaveLength(1);
  });

  it('says why a held queue is not moving', async () => {
    // A held queue will not move however long the user waits, which is
    // indistinguishable from the queue being broken unless it says so.
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();
    await submit(wrapper, 'queued behind a stop');

    expect(wrapper.text()).toContain('sent when this turn finishes');

    await wrapper.findAll('button').find((b) => b.text().includes('Stop'))!.trigger('click');
    await settle();

    expect(wrapper.text()).toContain('paused');
    expect(wrapper.text()).toContain('Send now');
  });

  it('does not release the queue by itself after a turn fails', async () => {
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();
    await submit(wrapper, 'next step');

    emitIpc(IPC_CHANNELS.CLAUDE_ERROR, CONV, 'something broke');
    await settle();

    expect(sentPrompts()).toEqual([]);
    expect(chat.queuedPrompts).toHaveLength(1);
  });

  it('resumes automatic release once the user starts new work', async () => {
    // A hold is about the turn they stopped, not about the conversation
    // forever. Sending something new means they have moved on, so the prompts
    // behind it should follow the next turn's end as usual.
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();
    await submit(wrapper, 'queued behind the stop');

    emitIpc(IPC_CHANNELS.CLAUDE_ERROR, CONV, 'something broke');
    await settle();
    expect(sentPrompts()).toEqual([]);

    // New work, sent directly because nothing is running.
    await submit(wrapper, 'a fresh start');
    await settle();
    expect(sentPrompts()).toEqual(['a fresh start']);

    emitIpc(IPC_CHANNELS.CLAUDE_DONE, CONV);
    await settle();

    expect(sentPrompts()).toEqual(['a fresh start', 'queued behind the stop']);
  });

  it('sends one prompt, not two, when the turn end and the re-check coincide', async () => {
    // Both the turn-end handler and the condition watcher ask at once when a
    // turn finishes. Each taking a prompt would start two turns at the same
    // time in one conversation.
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();
    await submit(wrapper, 'first');
    await submit(wrapper, 'second');

    emitIpc(IPC_CHANNELS.CLAUDE_DONE, CONV);
    await settle();

    expect(sentPrompts()).toEqual(['first']);
    expect(chat.queuedPrompts.map((p) => p.content)).toEqual(['second']);
  });

  it('holds a queue belonging to a conversation the user has left', async () => {
    // sendMessage only targets the conversation in view, so releasing this
    // would append to the wrong transcript.
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();
    await submit(wrapper, 'for the first conversation');

    chat.currentConversationId = 'conv-elsewhere';
    useConversationsStore().currentConversationId = 'conv-elsewhere';
    await settle();

    emitIpc(IPC_CHANNELS.CLAUDE_DONE, CONV);
    await settle();

    expect(sentPrompts()).toEqual([]);
    expect(chat.getConversationState(CONV).queuedPrompts).toHaveLength(1);
  });

  it('ignores an empty submission mid-turn', async () => {
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();

    await submit(wrapper, '   ');

    expect(chat.queuedPrompts).toHaveLength(0);
  });

  it('leaves Shift+Enter to insert a newline rather than queueing', async () => {
    const wrapper = mountHost();
    chat.setLoading(CONV, true);
    await settle();

    const textarea = wrapper.find('textarea');
    await textarea.setValue('still typing');
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: true });
    await settle();

    expect(chat.queuedPrompts).toHaveLength(0);
  });
});
