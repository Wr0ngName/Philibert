/**
 * Virtualised rendering of the message list.
 *
 * The complaint behind this: every message stayed mounted, so a long
 * conversation piled up until the window became unusable. These tests check
 * the thing that actually matters — that a long conversation mounts only a
 * slice of its rows — which needs layout, and happy-dom has none. So both
 * halves of layout are stubbed:
 *
 *   - ResizeObserver, which the composable requires before it will virtualise
 *     at all (without it there is no way to measure, and rendering everything
 *     is the safe answer).
 *   - offsetHeight on every element, so rows report a height instead of 0.
 *
 * What is NOT covered here is how any of it looks. A sliced bubble and a
 * translated window cannot be verified without a real layout engine.
 */

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';

import { useChatStore } from '../../../stores/chat';
import MessageList from '../MessageList.vue';

const ROW_HEIGHT = 50;
const VIEWPORT_HEIGHT = 500;

/** Mutable, so a row can be made to grow after it has been measured. */
let rowHeight = ROW_HEIGHT;

/** Captured resize callbacks, so a row changing height can be simulated. */
let resizeCallbacks: ResizeObserverCallback[] = [];

class MockResizeObserver implements ResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    resizeCallbacks.push(cb);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** Report that an already-measured row changed size. */
function fireRowResize(target: Element): void {
  for (const cb of resizeCallbacks) {
    cb(
      [{ target } as unknown as ResizeObserverEntry],
      null as unknown as ResizeObserver,
    );
  }
}

let offsetHeightSpy: PropertyDescriptor | undefined;

function stubLayout(): void {
  offsetHeightSpy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      return rowHeight;
    },
  });
}

function restoreLayout(): void {
  if (offsetHeightSpy) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeightSpy);
  } else {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
  }
}

/** Seed a conversation of alternating user and assistant messages. */
function seedConversation(count: number): void {
  const store = useChatStore();
  store.setCurrentConversation('conv-virtual');
  for (let i = 0; i < count; i += 1) {
    store.addMessage({
      id: `msg-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}`,
      timestamp: i,
    });
  }
}

async function mountList() {
  const wrapper = mount(MessageList, {
    global: { stubs: { MessageItem: true, Icon: true, Spinner: true } },
  });

  const container = wrapper.find('.overflow-y-auto').element as HTMLElement;
  Object.defineProperty(container, 'clientHeight', {
    value: VIEWPORT_HEIGHT,
    configurable: true,
  });
  Object.defineProperty(container, 'scrollHeight', {
    value: 100_000,
    configurable: true,
  });

  // First paint runs with a zero viewport, which deliberately renders
  // everything so the rows can be measured at all; the window narrows once
  // the container has been read.
  container.dispatchEvent(new Event('scroll'));
  await nextTick();
  await nextTick();

  return { wrapper, container };
}

describe('MessageList virtualisation', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    rowHeight = ROW_HEIGHT;
    resizeCallbacks = [];
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    stubLayout();
  });

  afterEach(() => {
    restoreLayout();
    vi.unstubAllGlobals();
  });

  it('mounts only a slice of a long conversation', async () => {
    seedConversation(300);
    const { wrapper } = await mountList();

    const rendered = wrapper.findAll('.chat-row').length;

    // A 500px viewport of 50px rows is ten rows, plus overscan either side.
    // The exact number is not the point; that it is a small fraction is.
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(60);
  });

  it('renders every message of a short conversation', async () => {
    // Below the threshold there is nothing to gain, and the simple path keeps
    // the behaviour identical to before.
    //
    // Counted by message rather than by row: an assistant turn is a header row
    // plus a row per item, so ten messages legitimately produce more than ten
    // rows.
    seedConversation(10);
    const { wrapper } = await mountList();

    const ids = wrapper.findAll('[data-message-id]').map((n) => n.attributes('data-message-id'));
    expect(new Set(ids).size).toBe(10);
  });

  it('reserves the full scroll height so the scrollbar reflects the whole conversation', async () => {
    seedConversation(300);
    const { wrapper } = await mountList();

    const spacer = wrapper.find('.overflow-y-auto > div[style*="height"]');
    expect(spacer.exists()).toBe(true);
    const height = Number.parseInt(
      (spacer.element as HTMLElement).style.height.replace('px', ''),
      10,
    );
    // 300 rows at 50px, give or take rows still carrying an estimate.
    expect(height).toBeGreaterThan(300 * ROW_HEIGHT * 0.5);
  });

  it('renders a different slice after scrolling', async () => {
    seedConversation(300);
    const { wrapper, container } = await mountList();

    const idsAtTop = wrapper.findAll('[data-message-id]').map((n) => n.attributes('data-message-id'));

    Object.defineProperty(container, 'scrollTop', { value: 6_000, configurable: true });
    container.dispatchEvent(new Event('scroll'));
    await nextTick();

    const idsAfterScroll = wrapper
      .findAll('[data-message-id]')
      .map((n) => n.attributes('data-message-id'));

    expect(idsAfterScroll).not.toEqual(idsAtTop);
    expect(idsAfterScroll.length).toBeGreaterThan(0);
  });

  it('does not drag a slow scroll back to the bottom', async () => {
    // The reported bug, and the reason it is no longer timing-dependent.
    //
    // Scrolling slides the window, which mounts and unmounts rows. That used
    // to be read as new content and snapped the view back whenever the user
    // was still inside SCROLL_THRESHOLD — so a slow scroll went nowhere. A
    // settle timer only hid it: whether it helped depended on how far apart
    // the scroll events fell. Re-pinning is now driven by the row count,
    // which scrolling does not change.
    seedConversation(300);
    const { wrapper, container } = await mountList();

    Object.defineProperty(container, 'scrollTop', { value: 99_950, writable: true, configurable: true });
    container.dispatchEvent(new Event('scroll')); // still within the threshold
    await nextTick();
    await nextTick();

    expect(container.scrollTop).toBe(99_950);
    // And the window really did move, so this is not passing vacuously.
    expect(wrapper.findAll('.chat-row').length).toBeLessThan(60);
  });

  it('re-pins when rows are added while following the tail', async () => {
    // What the removed observer was for: content appearing without the user
    // scrolling — a new message, or a sub-agent's children being expanded.
    seedConversation(300);
    const { container } = await mountList();

    Object.defineProperty(container, 'scrollTop', { value: 99_950, writable: true, configurable: true });
    container.dispatchEvent(new Event('scroll')); // at bottom, following
    await nextTick();

    useChatStore().addUserMessage('another message');
    await nextTick();
    await nextTick();

    expect(container.scrollTop).toBe(100_000); // scrollHeight
  });

  it('re-pins when a row grows in place while following the tail', async () => {
    // The case the removed MutationObserver also covered and the rows-length
    // watcher cannot see: content getting taller without a new row — a
    // background task gaining its summary, a tool row being enriched, an
    // image finishing loading.
    seedConversation(300);
    const { wrapper, container } = await mountList();

    Object.defineProperty(container, 'scrollTop', { value: 99_950, writable: true, configurable: true });
    container.dispatchEvent(new Event('scroll')); // at bottom, following
    await nextTick();

    // A row that has already been measured now reports a bigger height.
    rowHeight = 200;
    fireRowResize(wrapper.findAll('.chat-row')[0].element);
    await nextTick();

    expect(container.scrollTop).toBe(100_000); // scrollHeight
  });

  it('does not re-pin when a row grows after the user has scrolled away', async () => {
    seedConversation(300);
    const { wrapper, container } = await mountList();

    Object.defineProperty(container, 'scrollTop', { value: 1_000, writable: true, configurable: true });
    container.dispatchEvent(new Event('scroll'));
    await nextTick();

    rowHeight = 200;
    fireRowResize(wrapper.findAll('.chat-row')[0].element);
    await nextTick();

    // Asserted as "nowhere near the bottom" rather than "unchanged": a row
    // above the viewport growing legitimately moves the scroll position, by
    // exactly as much as the content above gained, so that what the user is
    // reading stays put. That anchor correction is the fix for sticky
    // upward scrolling — what must not happen is a jump to the tail.
    expect(container.scrollTop).not.toBe(100_000);
    expect(container.scrollTop).toBeLessThan(50_000);
  });

  it('does not re-pin when rows are added after the user has scrolled away', async () => {
    seedConversation(300);
    const { container } = await mountList();

    Object.defineProperty(container, 'scrollTop', { value: 1_000, writable: true, configurable: true });
    container.dispatchEvent(new Event('scroll')); // well clear of the bottom
    await nextTick();

    useChatStore().addUserMessage('another message');
    await nextTick();
    await nextTick();

    expect(container.scrollTop).toBe(1_000);
  });

  it('renders everything when ResizeObserver is unavailable', async () => {
    // The safety valve: with no way to measure, a wrong slice is worse than a
    // heavy list, so it must not virtualise at all.
    vi.stubGlobal('ResizeObserver', undefined);
    seedConversation(120);
    const { wrapper } = await mountList();

    const ids = wrapper.findAll('[data-message-id]').map((n) => n.attributes('data-message-id'));
    expect(new Set(ids).size).toBe(120);
  });
});
