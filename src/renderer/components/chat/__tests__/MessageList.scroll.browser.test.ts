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
import { commands } from 'vitest/browser';

import { useChatStore } from '../../../stores/chat';
import MessageList from '../MessageList.vue';

/** Enough rows to be well past the virtualisation threshold. */
const MESSAGE_COUNT = 400;

/**
 * Seed a conversation whose rows differ in height the way a real one does:
 * short prompts and tool-sized lines next to long answers. The spread is the
 * point — it is what makes any single estimate wrong.
 */
/**
 * A sentence that wraps, repeated. Row heights have to vary the way a real
 * conversation's do — a one-line prompt next to an answer with a code block in
 * it — because the defects here all live in the gap between a row's estimated
 * height and its real one. An earlier version of this file used a narrow
 * spread and passed against a list where a slow scroll travelled *backwards*.
 */
const PARAGRAPH = 'This answer runs on for several lines so that it wraps. ';

/** Repeats per row, cycling: a very long answer down to a bare one-liner. */
const LENGTHS = [60, 20, 8, 0, 0];

function messagesFor(prefix: string, count = MESSAGE_COUNT) {
  return Array.from({ length: count }, (_unused, index) => {
    const repeats = LENGTHS[index % LENGTHS.length];
    return {
      id: `${prefix}-${index}`,
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content:
        repeats === 0
          ? `Message ${index}`
          : `Message ${index}. ${PARAGRAPH.repeat(repeats)}`,
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
 * Scroll up with real wheel clicks and report how far the content travelled.
 *
 * Travel is measured against a row, not against `scrollTop`. The list moves
 * the scroll position itself whenever a row above the viewport is measured —
 * that is how it holds the content still — so `scrollTop` legitimately ends
 * somewhere unrelated to the gesture, while the row the user is looking at
 * should have moved down by exactly as far as they scrolled.
 *
 * `framesBetween` is the cadence, and it matters more than anything else here:
 * a burst of clicks all land before any measurement runs and travelled
 * correctly even when the list was badly broken. The defects only appear when
 * each click is followed by a measurement pass, which is what rolling a wheel
 * at a human speed does.
 */
async function wheelUp(
  container: HTMLElement,
  clicks: number,
  perClick: number,
  framesBetween: number,
): Promise<number> {
  const anchor = topRowElement(container);
  if (!anchor) throw new Error('no rendered row to measure against');

  const offset = () =>
    anchor.getBoundingClientRect().top - container.getBoundingClientRect().top;
  const before = offset();

  for (let click = 0; click < clicks; click += 1) {
    await commands.wheel(WHEEL_TARGET, -perClick);
    await settle(framesBetween);
  }
  // Long enough for Chromium's wheel animation and every resulting
  // measurement to finish, so a slow scroll is not mistaken for a lost one.
  await settle(30);

  return offset() - before;
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

/** Where the wheel command puts the pointer: the scroll container itself. */
const WHEEL_TARGET = '.overflow-y-auto';

/**
 * Frames to wait between wheel clicks, to stand in for a hand rolling a wheel
 * rather than flicking it: long enough that each click's measurement pass runs
 * before the next one arrives, which is the condition every scrolling defect
 * in this list has needed.
 */
const SLOW_CADENCE_FRAMES = 6;

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

  it('turns off the browser s own scroll anchoring', async () => {
    // Asserted directly, because the behaviour below depends entirely on it
    // and a stylesheet change could remove it without any other test noticing.
    // The list corrects the scroll position itself, from knowledge the browser
    // does not have — that a row's height just went from an estimate to a
    // measurement — so with both of them compensating, the user's gesture is
    // what gets cancelled.
    seedConversation();
    const { container } = await mountList();

    expect(getComputedStyle(container).overflowAnchor).toBe('none');
  });

  it('travels a full wheel click per click, at every cadence, from the bottom', async () => {
    // The user's report, in their words: "it still feels like it's registering
    // 1 scroll click out of 10". Measured from the end of the conversation,
    // four clicks of 100px: the content moved 0px at every cadence.
    seedConversation();
    const { container } = await mountList();

    await clearMeasurements();
    container.scrollTop = container.scrollHeight;
    await settle();

    // Four clicks of 100px, kept under one viewport so the row being measured
    // against stays rendered and keeps reporting a real position.
    const travelled = await wheelUp(container, 4, 100, SLOW_CADENCE_FRAMES);
    expect(travelled).toBeGreaterThan(4 * 100 * 0.8);
  });

  it('travels a full wheel click per click when scrolling up mid-conversation', async () => {
    // The same gesture from the middle, where rows above have never been
    // rendered, was the worst case: the content moved 158px the WRONG way.
    seedConversation();
    const { container } = await mountList();

    await clearMeasurements();
    container.scrollTop = Math.floor(container.scrollHeight * 0.5);
    await settle();

    const travelled = await wheelUp(container, 4, 100, SLOW_CADENCE_FRAMES);
    expect(travelled).toBeGreaterThan(4 * 100 * 0.8);
  });

  it('travels correctly for a fast flick too', async () => {
    // This cadence worked throughout, and that is the point of keeping it:
    // clicks that all land before any measurement runs are the one case the
    // defect spared, so a test that only flicks proves nothing. It is here to
    // document that, and to catch a fix that trades one cadence for the other.
    seedConversation();
    const { container } = await mountList();

    await clearMeasurements();
    container.scrollTop = Math.floor(container.scrollHeight * 0.5);
    await settle();

    const travelled = await wheelUp(container, 4, 100, 0);
    expect(travelled).toBeGreaterThan(4 * 100 * 0.8);
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
  // ===========================================================================
  // The window: history that is on disk but not in memory
  // ===========================================================================
  describe('a conversation held as a window', () => {
    /**
     * A conversation is opened as a window of its most recent messages — the
     * list used to grow for as long as the app ran, ~1.8 KB a message — so
     * there is history above the top of the list, and two new ways for the
     * view to be yanked: putting a page in front of it, and dropping rows off
     * the back of it after a save.
     *
     * Both are geometry, so both belong here rather than in the happy-dom
     * suite where every row has a height of zero.
     *
     * `window.electron` is stood up for the earlier-page fetch because there
     * is no IPC in a browser at all — Electron is the thing that is missing,
     * not anything of ours. Everything else is real: the component, both
     * stores, the virtual list, the scroll memory.
     */
    const OLDER_COUNT = 1000;

    /** The pages that sit behind the window, as the file would hold them. */
    function olderMessages() {
      return messagesFor('older', OLDER_COUNT);
    }

    function installIpc(): void {
      const older = olderMessages();
      (window as unknown as { electron: unknown }).electron = {
        conversation: {
          getOlder: async (_id: string, beforeId: string, limit: number) => {
            const at = older.findIndex((m) => m.id === beforeId);
            const end = at === -1 ? older.length : at;
            const start = Math.max(0, end - limit);
            return { messages: older.slice(start, end), olderCount: start };
          },
        },
        config: { get: async () => ({}), set: async () => undefined, onChange: () => () => {} },
      };
    }

    /** A window whose history continues above it. */
    async function seedWindowed() {
      installIpc();
      const store = useChatStore();
      store.setCurrentConversation('conv-browser');
      // The tail of the conversation, as `getWindow` would return it, with
      // the page before it addressable by the id at the top.
      const older = olderMessages();
      store.loadMessages(messagesFor('msg'), OLDER_COUNT);
      store.prependOlderMessages('conv-browser', [older[OLDER_COUNT - 1]], OLDER_COUNT - 1);
      return mountList();
    }

    it('offers the way back into the rest of the conversation', async () => {
      const { container } = await seedWindowed();

      const button = container.querySelector('button');
      expect(button?.textContent).toContain('Load earlier messages');
    });

    it('keeps the message being read in place when a page is prepended', async () => {
      // The whole point of the correction: prepending grows the content above
      // the viewport, which would otherwise push what the user is reading
      // down the screen by the height of the entire page.
      const { container, wrapper } = await seedWindowed();

      // Read some history, away from the tail.
      await wheelUp(container, 10, 120, 2);
      const anchor = topRowElement(container);
      if (!anchor) throw new Error('no row to anchor on');
      const anchorId = anchor.dataset.messageId;
      const offsetBefore = anchor.getBoundingClientRect().top
        - container.getBoundingClientRect().top;

      const button = wrapper.find('button');
      await button.trigger('click');
      await settle(20);

      const held = useChatStore().messages.length;
      expect(held).toBeGreaterThan(400);

      const after = container.querySelector<HTMLElement>(`[data-message-id="${anchorId}"]`);
      expect(after, 'the row being read is still rendered').not.toBeNull();
      const offsetAfter = after!.getBoundingClientRect().top
        - container.getBoundingClientRect().top;

      // Within a row's worth of movement: the prepended rows are measured
      // after they mount, so the correction settles rather than being exact.
      expect(Math.abs(offsetAfter - offsetBefore)).toBeLessThan(120);
    });

    it('does not move the view when the window is trimmed at the tail', async () => {
      // Trimming happens after a save, at the end of every turn, and removes
      // rows ABOVE the viewport. At the tail the browser clamps the scroll
      // offset and nothing should appear to happen.
      const { container } = await seedWindowed();
      expect(distanceFromBottom(container)).toBeLessThan(SETTLE_TOLERANCE_PX);
      const lastBefore = useChatStore().messages.at(-1)?.id;

      const dropped = useChatStore().trimWindow('conv-browser', 200);
      await settle(20);

      expect(dropped).toBeGreaterThan(0);
      expect(distanceFromBottom(container)).toBeLessThan(SETTLE_TOLERANCE_PX);
      expect(useChatStore().messages.at(-1)?.id).toBe(lastBefore);
    });

    it('still follows the tail after a trim', async () => {
      const { container } = await seedWindowed();
      useChatStore().trimWindow('conv-browser', 200);
      await settle(10);

      useChatStore().addMessage({
        id: 'after-trim',
        role: 'assistant',
        content: 'arrived after the trim',
        timestamp: 999999,
      });
      await settle(10);

      expect(distanceFromBottom(container)).toBeLessThan(SETTLE_TOLERANCE_PX);
    });

    it('tells the store when the view leaves the tail, and when it returns', async () => {
      // This is the signal the trim is gated on: a conversation being read is
      // left alone, because dropping rows above the viewport would yank the
      // page forward. Measured here because only a real scroll can produce
      // it.
      const { container } = await seedWindowed();
      const store = useChatStore();
      expect(store.isTailPinned('conv-browser')).toBe(true);

      await wheelUp(container, 6, 120, 2);
      expect(store.isTailPinned('conv-browser')).toBe(false);

      container.scrollTop = container.scrollHeight;
      await settle(10);

      expect(store.isTailPinned('conv-browser')).toBe(true);
    });

    it('scrolls a windowed conversation as freely as a whole one', async () => {
      // The window must not change how the list scrolls: a wheel click still
      // travels a wheel click.
      const { container } = await seedWindowed();

      const travelled = await wheelUp(container, 8, 120, 2);

      expect(travelled).toBeGreaterThan(8 * 120 * 0.8);
    });
  });
});
