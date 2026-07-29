/**
 * Auto-scroll regression tests for MessageList.
 *
 * The scroll container is `absolute inset-0` inside a `flex-1` root, and the
 * background-task panel / task list / pending-actions blocks are flex siblings
 * below it. When one appears — an agent starting is the common case — the
 * container's clientHeight shrinks. No scroll event fires (scrollTop is
 * unchanged) and nothing mutates inside the container, so without a
 * ResizeObserver nothing re-pins the view and the tail of the conversation
 * disappears behind the panel.
 */

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { useChatStore } from '../../../stores/chat';
import MessageList from '../MessageList.vue';

/** Captures the ResizeObserver callbacks so a resize can be simulated. */
let resizeCallbacks: ResizeObserverCallback[] = [];
let observedTargets: Element[] = [];
let disconnectCount = 0;

class MockResizeObserver implements ResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    resizeCallbacks.push(cb);
  }
  observe(target: Element) { observedTargets.push(target); }
  unobserve() {}
  disconnect() { disconnectCount += 1; }
}

/** Simulate the viewport shrinking, as when the task panel appears. */
function fireResize() {
  for (const cb of resizeCallbacks) {
    cb([] as unknown as ResizeObserverEntry[], null as unknown as ResizeObserver);
  }
}

function mountList() {
  return mount(MessageList, {
    global: {
      stubs: { MessageItem: true, Icon: true, Spinner: true },
    },
  });
}

/** Give the scroll container real geometry; jsdom/happy-dom report zeroes. */
function stubGeometry(el: HTMLElement, opts: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, 'scrollHeight', { value: opts.scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: opts.clientHeight, configurable: true });
}

describe('MessageList auto-scroll', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resizeCallbacks = [];
    observedTargets = [];
    disconnectCount = 0;
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('observes the scroll viewport for size changes', () => {
    const wrapper = mountList();
    const container = wrapper.find('.overflow-y-auto').element as HTMLElement;

    expect(resizeCallbacks.length).toBe(1);
    expect(observedTargets).toContain(container);
  });

  // The regression: an agent starts, the panel takes vertical space, and the
  // conversation tail slides out of sight with nothing to bring it back.
  it('re-pins to the bottom when the viewport shrinks while following the tail', () => {
    const wrapper = mountList();
    const container = wrapper.find('.overflow-y-auto').element as HTMLElement;

    // Pinned to the bottom of a 1000px conversation in a 500px viewport.
    stubGeometry(container, { scrollHeight: 1000, clientHeight: 500 });
    container.scrollTop = 500;

    // The background-task panel appears and takes 120px.
    stubGeometry(container, { scrollHeight: 1000, clientHeight: 380 });
    fireResize();

    expect(container.scrollTop).toBe(1000);
  });

  it('leaves the position alone when the user has scrolled up', async () => {
    const wrapper = mountList();
    const container = wrapper.find('.overflow-y-auto').element as HTMLElement;

    stubGeometry(container, { scrollHeight: 1000, clientHeight: 500 });
    // Well above the bottom — the user is reading history.
    container.scrollTop = 100;
    await container.dispatchEvent(new Event('scroll'));

    stubGeometry(container, { scrollHeight: 1000, clientHeight: 380 });
    fireResize();

    expect(container.scrollTop).toBe(100);
  });

  it('disconnects the observer on unmount', () => {
    const wrapper = mountList();
    wrapper.unmount();
    // Content observer + viewport observer both disconnect; the viewport one
    // is the ResizeObserver mock.
    expect(disconnectCount).toBeGreaterThanOrEqual(1);
  });

  it('does not throw when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    expect(() => mountList()).not.toThrow();
  });
});

describe('MessageList auto-scroll — streaming still follows', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resizeCallbacks = [];
    observedTargets = [];
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('scrolls to the bottom as streamed content arrives', async () => {
    const chat = useChatStore();
    const wrapper = mountList();
    const container = wrapper.find('.overflow-y-auto').element as HTMLElement;

    stubGeometry(container, { scrollHeight: 1000, clientHeight: 500 });
    container.scrollTop = 500;

    stubGeometry(container, { scrollHeight: 1400, clientHeight: 500 });
    // currentStreamingContent is scoped to the current conversation, so the
    // watcher only fires for the conversation the list is showing.
    chat.currentConversationId = 'conv-1';
    chat.appendChunk('conv-1', 'more text');
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(container.scrollTop).toBe(1400);
  });
});
