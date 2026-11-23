/**
 * A turn's bubble, drawn as a stack of slices — header, content, trailing
 * spinner — one row each, in a real browser: whether its sides run unbroken
 * is geometry, which happy-dom does not have.
 *
 * The slices only make one bubble if each starts where the one above ends.
 * The header's margin escaped its slice once, opening a gap between the rows
 * that broke the bubble's sides under the header, outside the row heights the
 * window is measured from.
 *
 * Run with `npm run test:browser` (not part of `npm test` or CI).
 */

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useChatStore } from '../../../stores/chat';
import { useConversationsStore } from '../../../stores/conversations';
import MessageList from '../MessageList.vue';

const CONVERSATION = 'conv-bubble';
let host: HTMLElement | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  host?.remove();
  host = null;
});

/** Wait for layout, measurement and the resulting re-render to finish. */
async function settle(frames = 6): Promise<void> {
  for (let i = 0; i < frames; i += 1) {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }
}

async function mountList() {
  host = document.createElement('div');
  host.style.width = '800px';
  host.style.height = '600px';
  document.body.appendChild(host);
  const wrapper = mount(MessageList, { attachTo: host });
  const container = wrapper.find('.overflow-y-auto').element as HTMLElement;
  Object.assign(container.style, { position: 'absolute', inset: '0', overflowY: 'auto' });
  (wrapper.element as HTMLElement).style.position = 'relative';
  (wrapper.element as HTMLElement).style.height = '600px';
  await settle();
  return wrapper;
}

/** The space between each slice of a bubble and the one above it, in pixels. */
function gapsBetweenSlices(): number[] {
  const slices = [...document.querySelectorAll('.turn-slice')].map((slice) => slice.getBoundingClientRect());
  return slices.slice(1).map((slice, index) => Math.round((slice.top - slices[index]!.bottom) * 100) / 100);
}

describe("a turn's bubble", () => {
  it('runs unbroken from its header through its text to its spinner while the reply is written', async () => {
    const chat = useChatStore();
    chat.setCurrentConversation(CONVERSATION);
    useConversationsStore().currentConversationId = CONVERSATION;
    chat.loadMessages([{ id: 'question', role: 'user', content: 'Hello', timestamp: 1 }], 0);
    chat.startAssistantMessage(CONVERSATION);
    chat.setLoading(CONVERSATION, true);
    chat.appendChunk(CONVERSATION, 'A first paragraph.\n\n1. a list\n2. that ends the text so far');
    await mountList();

    expect(document.querySelectorAll('.turn-slice').length).toBeGreaterThanOrEqual(3);
    expect(gapsBetweenSlices().every((gap) => gap === 0)).toBe(true);
  });

  it('runs unbroken from its header through its text once the reply is done', async () => {
    const chat = useChatStore();
    chat.setCurrentConversation(CONVERSATION);
    useConversationsStore().currentConversationId = CONVERSATION;
    chat.loadMessages([
      { id: 'question', role: 'user', content: 'Hello', timestamp: 1 },
      { id: 'answer', role: 'assistant', content: 'An answer.\n\n- that ends\n- on a list', timestamp: 2 },
    ], 0);
    await mountList();

    expect(document.querySelectorAll('.turn-slice').length).toBeGreaterThanOrEqual(2);
    expect(gapsBetweenSlices()).toEqual(gapsBetweenSlices().map(() => 0));
  });
});
