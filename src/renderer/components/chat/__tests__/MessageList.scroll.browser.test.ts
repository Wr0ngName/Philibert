/**
 * Scrolling the message list, in a real browser.
 *
 * This file exists because the happy-dom suite cannot test this and quietly
 * pretended otherwise. Scrolling a virtualised list is entirely about
 * geometry: rows have real heights, unmeasured rows carry an estimate, and
 * measuring them moves everything below. happy-dom has no layout engine, so
 * every height is 0 and all of that has to be stubbed — and stubbing it is
 * what hid the defect. Three attempts at a stubbed version passed against
 * code that was broken:
 *
 *   1. one constant height for every row — the estimate then equals every
 *      real height, so the gap the bug lives in does not exist;
 *   2. varying the height globally — already-measured rows then report a new
 *      height, which is the "content changed size" path that always worked;
 *   3. alternating tall and short — the rows above the anchor cancel out and
 *      the net correction is zero either way.
 *
 * Here the browser decides the heights, so none of that applies.
 *
 * Run with `npm run test:browser` (not part of `npm test` or CI).
 */

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach } from 'vitest';

import { useChatStore } from '../../../stores/chat';
import MessageList from '../MessageList.vue';

/** Enough rows to be well past the virtualisation threshold. */
const MESSAGE_COUNT = 400;

/**
 * Seed a conversation whose rows differ in height the way a real one does:
 * short prompts and tool-sized lines next to long answers. The spread is the
 * point — it is what makes any single estimate wrong.
 */
function messagesFor(prefix: string, count = MESSAGE_COUNT) {
  return Array.from({ length: count }, (_unused, index) => {
    const long = index % 3 === 0;
    return {
      id: `${prefix}-${index}`,
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: long
        ? `Message ${index}. ${'This answer runs on for several lines so that it wraps. '.repeat(8)}`
        : `Message ${index}`,
      timestamp: index,
    };
  });
}

function seedConversation(): void {
  const store = useChatStore();
  store.setCurrentConversation('conv-browser');
  for (const message of messagesFor('msg')) store.addMessage(message);
}

/**
 * Switch conversation the way the app does.
 *
 * `conversations.loadConversation` replaces the message list and then sets the
 * current id — two separate store calls, in that order. Reproducing both
 * matters: the component's watchers see a new row set and a new id in the same
 * flush, which is where the position has to be saved for the conversation
 * being left and restored for the one being entered.
 */
async function switchTo(id: string, prefix: string): Promise<void> {
  const store = useChatStore();
  store.loadMessages(messagesFor(prefix));
  store.setCurrentConversation(id);
  await settle();
}

/**
 * Mount into a real, sized, scrollable element.
 *
 * The geometry is applied with inline styles rather than relying on the app's
 * classes: no stylesheet is loaded here, so `absolute inset-0 overflow-y-auto`
 * and `flex-1` are inert class names and the container would grow to its
 * content instead of scrolling. (Found the hard way — the first run reported a
 * clientHeight of 1.2 million pixels.) Exact padding is not what these tests
 * are about; a bounded, scrollable viewport with real row heights is.
 */
async function mountList() {
  const host = document.createElement('div');
  host.style.width = '800px';
  host.style.height = '600px';
  document.body.appendChild(host);

  const wrapper = mount(MessageList, { attachTo: host });

  const root = wrapper.element as HTMLElement;
  root.style.position = 'relative';
  root.style.height = '600px';
  root.style.width = '800px';

  const container = wrapper.find('.overflow-y-auto').element as HTMLElement;
  container.style.position = 'absolute';
  container.style.top = '0';
  container.style.left = '0';
  container.style.right = '0';
  container.style.bottom = '0';
  container.style.overflowY = 'auto';

  // Let the first paint settle: rows mount, the ResizeObserver reports their
  // heights, and the window narrows to the viewport.
  await settle();

  return { wrapper, container, host };
}

/** Wait for layout, measurement and the resulting re-render to finish. */
async function settle(frames = 6): Promise<void> {
  for (let i = 0; i < frames; i += 1) {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }
}

/**
 * Discard every row measurement, through the component's own reset path.
 *
 * Switching conversation is what triggers it in the app, and it leaves the
 * list in the state a freshly opened conversation is in: the viewport is
 * known, so only the rows around it are rendered and measured, and everything
 * else carries an estimate.
 */
async function clearMeasurements(): Promise<void> {
  const store = useChatStore();
  store.setCurrentConversation('conv-elsewhere');
  await settle(2);
  store.setCurrentConversation('conv-browser');
  await settle();
}

/**
 * How far the tail sits below the viewport. Zero means pinned to the bottom.
 */
function distanceFromBottom(container: HTMLElement): number {
  return container.scrollHeight - container.scrollTop - container.clientHeight;
}

/**
 * What still counts as "at the bottom".
 *
 * The component's own SCROLL_THRESHOLD is 80px — inside it, it considers the
 * user to be following the tail — so anything under that is indistinguishable
 * from pinned as far as the behaviour goes.
 */
const SETTLE_TOLERANCE_PX = 80;

/** The rendered row element nearest the top of the viewport. */
function topRowElement(container: HTMLElement): HTMLElement | null {
  const top = container.getBoundingClientRect().top;
  let best: { el: HTMLElement; delta: number } | null = null;

  for (const el of container.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const delta = Math.abs(el.getBoundingClientRect().top - top);
    if (!best || delta < best.delta) best = { el, delta };
  }

  return best?.el ?? null;
}

/** The message id of the row nearest the top of the viewport. */
function topMessageId(container: HTMLElement): string | null {
  const top = container.getBoundingClientRect().top;
  let best: { id: string; delta: number } | null = null;

  for (const el of container.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const id = el.getAttribute('data-message-id');
    if (!id) continue;
    const delta = Math.abs(el.getBoundingClientRect().top - top);
    if (!best || delta < best.delta) best = { id, delta };
  }

  return best?.id ?? null;
}

describe('MessageList scrolling with real layout', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = '';
  });

  it('mounts only a fraction of a long conversation', async () => {
    seedConversation();
    const { wrapper, container } = await mountList();

    expect(container.scrollHeight).toBeGreaterThan(container.clientHeight * 5);
    expect(wrapper.findAll('.chat-row').length).toBeLessThan(MESSAGE_COUNT / 2);
  });

  it('actually moves when scrolled up a little at a time', async () => {
    // The reported bug: scrolling up slowly got nowhere, because rows above
    // were measured for the first time as they mounted, replacing their
    // estimate and pushing the content back down by about as much as the user
    // had just moved. Only a fast gesture outran it.
    seedConversation();
    const { container } = await mountList();

    // Clear the measurements first, which is not an artifice — it is the
    // normal state of a conversation the user has just opened. The very first
    // paint happens before the container's height is known, and a zero
    // viewport deliberately renders everything, so every row gets measured.
    // Switching conversation resets that, and from then on only the rows
    // around the viewport are ever measured. Scrolling therefore moves into
    // rows carrying nothing but an estimate, which is the condition the bug
    // needs.
    await clearMeasurements();

    container.scrollTop = container.scrollHeight;
    await settle();

    // Measured against the content, not the scroll position.
    //
    // "scrollTop went down" is too weak a claim — it was true even while the
    // conversation sat still, which is the whole complaint. And it cannot be
    // "scrollTop moved by exactly what I asked", because a correct
    // implementation deliberately adjusts the position when rows above are
    // measured; that is what holds the content still. So the question is
    // whether a specific row moved down the screen by as far as the user
    // scrolled up.
    const anchor = topRowElement(container);
    expect(anchor).not.toBeNull();
    const containerTop = () => container.getBoundingClientRect().top;
    const anchorOffset = () => anchor!.getBoundingClientRect().top - containerTop();
    const before = anchorOffset();

    // Eight steps of 60px, the way a wheel behaves. Kept under one viewport so
    // the anchor row stays rendered and measurable throughout.
    const steps = 8;
    const perStep = 60;
    for (let step = 0; step < steps; step += 1) {
      container.scrollTop -= perStep;
      await settle(3);
    }

    // The anchor should now sit about `steps * perStep` further down. Allowing
    // a fifth of it covers sub-pixel settling; the defect lost far more than
    // that — measured at roughly a quarter of the intended distance.
    // The anchor should now sit about `steps * perStep` further down. A fifth
    // of tolerance covers sub-pixel settling; the defect lost far more — the
    // content travelled 345px of an intended 480px.
    const travelled = anchorOffset() - before;
    expect(travelled).toBeGreaterThan(steps * perStep * 0.8);
  });

  it('keeps the view still while rows above it are measured', async () => {
    // The mechanism behind the fix, asserted directly: after scrolling into
    // rows that have never rendered, whatever is under the top of the viewport
    // should stay there as those rows get measured.
    seedConversation();
    const { container } = await mountList();

    container.scrollTop = Math.floor(container.scrollHeight * 0.6);
    await settle();

    const before = topMessageId(container);
    // More measurement happens as the rows above settle.
    await settle(10);

    expect(topMessageId(container)).toBe(before);
  });

  it('follows the tail when a message arrives while at the bottom', async () => {
    seedConversation();
    const { container } = await mountList();

    container.scrollTop = container.scrollHeight;
    await settle();

    useChatStore().addUserMessage('a brand new message');
    await settle();

    expect(distanceFromBottom(container)).toBeLessThan(SETTLE_TOLERANCE_PX);
  });

  it('does not follow the tail once scrolled away', async () => {
    seedConversation();
    const { container } = await mountList();

    container.scrollTop = Math.floor(container.scrollHeight * 0.3);
    await settle();
    const before = container.scrollTop;

    useChatStore().addUserMessage('a brand new message');
    await settle();

    // Allowed to shift by an anchor correction, but nowhere near the bottom.
    expect(container.scrollTop).toBeLessThan(container.scrollHeight * 0.6);
    expect(Math.abs(container.scrollTop - before)).toBeLessThan(container.clientHeight * 3);
  });

  it('stays at the bottom while idle', async () => {
    // Nothing is streaming and no message arrives — the list should simply
    // stay where it was put. It did not: rows near the tail get measured for
    // the first time after the jump, which changes the total height, and
    // nothing re-pinned afterwards.
    seedConversation();
    const { container } = await mountList();

    await clearMeasurements();
    container.scrollTop = container.scrollHeight;
    await settle();

    // Long enough for every pending measurement to land.
    await settle(20);

    expect(distanceFromBottom(container)).toBeLessThan(SETTLE_TOLERANCE_PX);
  });

  it('stays where a nudge smaller than the at-bottom threshold put it', async () => {
    // The hazard in holding the bottom. `isUserAtBottom` is true anywhere
    // within 80px of the end, so re-pinning on that would drag a small
    // upward scroll straight back and make the last 80px impossible to leave
    // slowly — the stickiness this list has already been through once.
    seedConversation();
    const { container } = await mountList();

    await clearMeasurements();
    container.scrollTop = container.scrollHeight;
    await settle();

    const nudge = 30; // well inside SCROLL_THRESHOLD
    container.scrollTop -= nudge;
    await settle(20);

    expect(distanceFromBottom(container)).toBeGreaterThan(nudge / 2);
  });

  it('comes back to the bottom of a conversation it was following', async () => {
    seedConversation();
    const { container } = await mountList();

    container.scrollTop = container.scrollHeight;
    await settle();
    expect(distanceFromBottom(container)).toBeLessThan(SETTLE_TOLERANCE_PX);

    await switchTo('conv-other', 'other');
    await switchTo('conv-browser', 'msg');

    expect(distanceFromBottom(container)).toBeLessThan(SETTLE_TOLERANCE_PX);
  });

  it('comes back to where it was left in a conversation it was reading', async () => {
    seedConversation();
    const { container } = await mountList();

    container.scrollTop = Math.floor(container.scrollHeight * 0.4);
    await settle();
    const anchor = topMessageId(container);
    expect(anchor).not.toBeNull();

    await switchTo('conv-other', 'other');
    await switchTo('conv-browser', 'msg');

    // Same message under the top of the viewport, rather than the tail or the
    // top of the conversation.
    expect(topMessageId(container)).toBe(anchor);
  });

  it('starts a conversation it has never shown at the bottom', async () => {
    seedConversation();
    const { container } = await mountList();

    container.scrollTop = Math.floor(container.scrollHeight * 0.4);
    await settle();

    await switchTo('conv-unseen', 'unseen');

    // No remembered position, so the sensible place is the newest message —
    // and NOT the position the previous conversation happened to be at.
    expect(distanceFromBottom(container)).toBeLessThan(SETTLE_TOLERANCE_PX);
  });
});

