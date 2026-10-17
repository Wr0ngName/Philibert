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

import { CONSTANTS } from '../../../constants/app';
import { useChatStore } from '../../../stores/chat';
import { useConversationsStore } from '../../../stores/conversations';
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

/**
 * How much history sits behind the window in the windowed tests.
 *
 * Enough that reading back past WINDOW_MAX is reachable: the window opens at
 * 401 messages and a page is WINDOW_SIZE, so the third page is what first
 * takes the held list past the cap and makes it slide. At 1,000 it never did,
 * and the test that claimed to prove the window stays bounded was only
 * proving that 1,400 is less than 1,500.
 */
const OLDER_COUNT = 1600;

/** The pages that sit behind the window, as the file would hold them. */
function olderMessages() {
  return messagesFor('older', OLDER_COUNT);
}

/**
 * The whole conversation, the way the file holds it: the history behind the
 * window followed by the window itself.
 *
 * One array answers all three window reads, so paging back and forward cannot
 * disagree about what the conversation is — which a separate fixture per
 * direction did, and it took a test asserting a message was "newer" than
 * itself to notice.
 */
function wholeConversation() {
  return [...olderMessages(), ...messagesFor('msg')];
}

/**
 * Seed a conversation held as a window, with its history addressable behind
 * it.
 *
 * Sets the current id on BOTH stores. The earlier-page fetch reads it from
 * the conversations store, so leaving that unset makes the fetch a no-op —
 * which is how two tests here first passed while loading nothing at all, on
 * an assertion ("more than 400 messages") that the window already satisfied.
 */
function seedWindowedConversation(): void {
  installWindowIpc();
  const chat = useChatStore();
  const conversations = useConversationsStore();
  const older = olderMessages();
  chat.setCurrentConversation('conv-browser');
  conversations.currentConversationId = 'conv-browser';
  chat.loadMessages(messagesFor('msg'), OLDER_COUNT);
  // The row at the top is the last of the page behind it, so a page request
  // has something to key on.
  chat.prependOlderMessages('conv-browser', [older[OLDER_COUNT - 1]], OLDER_COUNT - 1);
}

/** While set, a newer-page request waits for it — see holdNewerPages. */
let newerPagesHeld: Promise<void> | null = null;

/**
 * Keep newer pages from arriving until the returned function is called.
 *
 * The stand-in IPC answers at once, so a page always landed while the reader
 * was still a screen short of the edge. In the app it is a read from disk,
 * and an ordinary scroll reaches the very end of the window before it
 * answers — which is the state the defects live in, and the one this makes
 * reachable on purpose rather than by timing.
 */
function holdNewerPages(): () => void {
  let release!: () => void;
  newerPagesHeld = new Promise<void>((resolve) => { release = resolve; });
  return () => {
    newerPagesHeld = null;
    release();
  };
}

/**
 * Stand in for Electron's IPC, which does not exist in a browser at all.
 *
 * Electron is the thing that is missing here, not anything of ours: the
 * component, both stores, the virtual list and the scroll memory are all
 * real, and this answers the earlier-page request the way the main process
 * would, out of the same fixture the window was cut from.
 */
function installWindowIpc(): void {
  const whole = wholeConversation();
  const indexOf = (id: string) => whole.findIndex((m) => m.id === id);
  newerPagesHeld = null;

  (window as unknown as { electron: unknown }).electron = {
    conversation: {
      getOlder: async (_id: string, beforeId: string, limit: number) => {
        const at = indexOf(beforeId);
        if (at === -1) throw new Error(`asked for history before an unknown message: ${beforeId}`);
        const start = Math.max(0, at - limit);
        return { messages: whole.slice(start, at), olderCount: start };
      },
      getNewer: async (_id: string, afterId: string, limit: number) => {
        if (newerPagesHeld) await newerPagesHeld;
        const at = indexOf(afterId);
        if (at === -1) throw new Error(`asked for messages after an unknown message: ${afterId}`);
        const end = Math.min(whole.length, at + 1 + limit);
        return { messages: whole.slice(at + 1, end), newerCount: whole.length - end };
      },
      getAround: async (_id: string, messageId: string, before: number, after: number) => {
        const at = indexOf(messageId);
        if (at === -1) return null;
        const start = Math.max(0, at - before);
        const end = Math.min(whole.length, at + 1 + after);
        return {
          messages: whole.slice(start, end), olderCount: start, newerCount: whole.length - end,
        };
      },
      getWindow: async (_id: string, limit: number) => {
        const start = Math.max(0, whole.length - limit);
        return {
          conversation: { id: 'conv-browser', messages: whole.slice(start) },
          olderCount: start,
        };
      },
    },
    config: { get: async () => ({}), set: async () => undefined, onChange: () => () => {} },
  };
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
 * Roll the wheel until something happens, or give up saying so.
 *
 * Paging is driven by the view reaching an edge of the window, so a test for
 * it has to actually get there with the wheel — and how many clicks that
 * takes depends on where the measured row heights put the content, which is
 * not something a test can know in advance. The guard is what keeps a failure
 * legible: "never reached the top of the window" rather than a silent
 * assertion about a count that never changed.
 *
 * Nothing here assigns `scrollTop`. Assigning it is not scrolling: the list
 * legitimately moves the offset itself while rows settle, so a gesture faked
 * that way gets undone and the test ends up measuring its own assignment.
 */
async function wheelUntil(
  direction: -1 | 1,
  done: () => boolean,
  what: string,
  clickPx = EDGE_CLICK_PX,
  maxClicks = 80,
): Promise<void> {
  for (let click = 0; click < maxClicks && !done(); click += 1) {
    await commands.wheel(WHEEL_TARGET, direction * clickPx);
    await settle(4);
  }
  // Long enough for the page request, the render and the measurements it
  // causes to finish before anything is asserted.
  await settle(30);
  if (!done()) throw new Error(`gave up rolling the wheel: ${what}`);
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
 * Wheel travel per click when crossing the window to reach one of its edges.
 *
 * Measured, not guessed: this fixture's window is ~98,500px of real rows and
 * a loaded page adds ~123,000px more, while the wheel travels exactly the
 * delta it is given (checked at 120, 400, 1,200, 3,000 and 8,000px — travel
 * matched the delta at every one). A 400px click therefore needs ~250 of them
 * to reach the top, which is how the first version of these tests failed:
 * "never reached the top of the window", eighty clicks in.
 *
 * Reaching an edge is a flick, so it is driven as one. The gentle 120px
 * clicks the travel and cadence tests use are unchanged — those are about how
 * far a roll moves the content, which is a different question.
 */
const EDGE_CLICK_PX = 8000;

/**
 * Wheel travel per click when the travel itself is being measured, so a page
 * arriving can be told apart from the gesture that fetched it.
 */
const FINE_CLICK_PX = 400;

/** The size the window is trimmed back to, and the slack before it is. */
const { WINDOW_MAX } = CONSTANTS.CONVERSATION;

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

/**
 * Roll the wheel one measured click at a time until a page arrives, and report
 * how far the row being read moved on the click it arrived during.
 *
 * Measured per click so that click can be judged on its own: the view may move
 * by that click's travel and by nothing else. A page is 500 messages — tens of
 * thousands of pixels — so anything beyond a click or two is the page landing
 * in front of the reader rather than out of their way. Null when no page
 * arrived.
 *
 * `unloaded` is how much lies beyond the edge being approached; a page
 * arriving is that count going down.
 */
async function travelWhileAPageArrives(
  container: HTMLElement,
  direction: -1 | 1,
  unloaded: () => number,
): Promise<number | null> {
  const offsetOf = (id: string) => {
    const row = container.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    return row
      ? row.getBoundingClientRect().top - container.getBoundingClientRect().top
      : null;
  };

  for (let click = 0; click < 60; click += 1) {
    const anchorId = topMessageId(container);
    const before = anchorId === null ? null : offsetOf(anchorId);
    const unloadedBefore = unloaded();

    await commands.wheel(WHEEL_TARGET, direction * FINE_CLICK_PX);
    await settle(6);

    if (unloaded() < unloadedBefore && anchorId !== null && before !== null) {
      const after = offsetOf(anchorId);
      expect(after, 'the row being read was unloaded by the page arriving').not.toBeNull();
      return after! - before;
    }
  }
  return null;
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
    /** A window whose history continues above it. */
    async function seedWindowed() {
      seedWindowedConversation();
      return mountList();
    }

    it('says how much of the conversation is not loaded', async () => {
      const { container } = await seedWindowed();
      const store = useChatStore();

      expect(store.olderMessageCount).toBeGreaterThan(0);
      expect(container.textContent).toContain(`${store.olderMessageCount} earlier messages`);
      // And there is nothing to press. Reaching for a control to carry on
      // reading is not scrolling.
      expect(container.textContent).not.toContain('Load earlier');
    });

    it('loads the previous page by being scrolled to, with nothing pressed', async () => {
      const { container } = await seedWindowed();
      const store = useChatStore();
      const olderBefore = store.olderMessageCount;
      const heldBefore = store.messages.length;

      await wheelUntil(
        -1,
        () => store.olderMessageCount < olderBefore,
        'never reached the top of the window',
      );

      // A page really arrived, and the accounting moved with it: asserted
      // against what was held before, because "more than the window" is true
      // of a window one message too big.
      expect(store.messages.length).toBeGreaterThan(heldBefore);
      expect(store.olderMessageCount).toBeLessThan(olderBefore);
      expect(store.olderMessageCount + store.messages.length)
        .toBe(olderBefore + heldBefore);
      // In order, with nothing repeated or skipped.
      const ids = store.messages.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(wholeConversation()
        .map((m) => m.id)
        .slice(store.olderMessageCount, store.olderMessageCount + ids.length));
      // And what is said about the rest followed it down.
      expect(container.textContent).toContain(`${store.olderMessageCount} earlier messages`);
    }, 120_000);

    it('keeps the message being read in place when a page arrives mid-gesture', async () => {
      // The difference from the prepend test above: there the page is handed
      // to the store, here the reader's own scrolling fetches it, so the
      // arrival lands in the middle of a gesture.
      const { container } = await seedWindowed();
      const store = useChatStore();

      // Flick up to within sight of the top, then switch to measured clicks
      // for the crossing itself. The threshold the page loads at is 600px, so
      // stopping at 15,000 is comfortably short of it.
      await wheelUntil(
        -1,
        () => container.scrollTop < 15_000,
        'never got within sight of the top',
      );
      expect(store.olderMessageCount, 'paged before the measuring began')
        .toBe(OLDER_COUNT - 1);

      const travelled = await travelWhileAPageArrives(
        container, -1, () => store.olderMessageCount,
      );

      expect(travelled, 'no page arrived while scrolling up').not.toBeNull();
      // Scrolling up moves the content down, so a click's travel is positive.
      expect(travelled!).toBeGreaterThan(0);
      expect(travelled!).toBeLessThan(FINE_CLICK_PX * 2);
    }, 120_000);

    it('does not end up holding the whole conversation when read back', async () => {
      // The window exists so a long conversation does not sit in memory in
      // full. Paging without unloading the other side would defeat it on the
      // way back to the start.
      const { container } = await seedWindowed();
      const store = useChatStore();
      const total = store.messages.length + store.olderMessageCount;

      let pages = 0;
      while (store.olderMessageCount > 0 && pages < 6) {
        const olderBefore = store.olderMessageCount;
        await wheelUntil(
          -1,
          () => store.olderMessageCount < olderBefore,
          `page ${pages + 1} never loaded`,
        );
        pages += 1;
        expect(store.messages.length).toBeLessThanOrEqual(WINDOW_MAX);
      }

      expect(pages).toBeGreaterThan(1);
      // Everything is still accounted for: what is held, plus what is behind
      // the window, plus the tail that was unloaded to make room.
      expect(store.messages.length + store.olderMessageCount + store.newerMessageCount)
        .toBe(total);
      expect(container.querySelectorAll('[data-message-id]').length)
        .toBeLessThan(store.messages.length);
    }, 180_000);

    it('reads forward again by scrolling back down', async () => {
      const { container } = await seedWindowed();
      const store = useChatStore();

      // Read back far enough that the tail is unloaded.
      let guard = 0;
      while (store.newerMessageCount === 0 && guard < 6) {
        const olderBefore = store.olderMessageCount;
        await wheelUntil(
          -1,
          () => store.olderMessageCount < olderBefore,
          'a page of history never loaded',
        );
        guard += 1;
      }
      expect(store.newerMessageCount, 'the tail was never unloaded').toBeGreaterThan(0);

      const newerBefore = store.newerMessageCount;
      await wheelUntil(
        1,
        () => store.newerMessageCount < newerBefore,
        'never reached the end of the window',
      );

      expect(store.newerMessageCount).toBeLessThan(newerBefore);
      expect(store.messages.length).toBeLessThanOrEqual(WINDOW_MAX);
      const ids = store.messages.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(container.querySelectorAll('[data-message-id]').length).toBeGreaterThan(0);
    }, 180_000);

    it('keeps the message being read in place when a newer page arrives', async () => {
      // The mirror of reading back. A page of newer messages belongs BELOW
      // the reader, ready for them to carry on into. It used to land and the
      // view was dragged to the end of it, so the page sat above the reader,
      // unread, and the bottom edge left no way to fetch the next one without
      // scrolling up and back down again.
      const { container } = await seedWindowed();
      const store = useChatStore();

      let guard = 0;
      while (store.newerMessageCount === 0 && guard < 6) {
        const olderBefore = store.olderMessageCount;
        await wheelUntil(
          -1,
          () => store.olderMessageCount < olderBefore,
          'a page of history never loaded',
        );
        guard += 1;
      }
      expect(store.newerMessageCount, 'the tail was never unloaded').toBeGreaterThan(0);

      // Close to the end of the window, then measured clicks for the crossing.
      await wheelUntil(
        1,
        () => distanceFromBottom(container) < 15_000,
        'never got within sight of the end of the window',
      );

      const travelled = await travelWhileAPageArrives(
        container, 1, () => store.newerMessageCount,
      );

      expect(travelled, 'no page arrived while scrolling down').not.toBeNull();
      // Scrolling down moves the content up, so a click's travel is negative.
      expect(travelled!).toBeLessThan(0);
      expect(travelled!).toBeGreaterThan(-FINE_CLICK_PX * 2);
      // And the page is there to read on into, not behind the view.
      expect(distanceFromBottom(container)).toBeGreaterThan(5_000);
    }, 240_000);

    it('keeps the reader in place when a newer page arrives after they reached the end of the window', async () => {
      // How it happens in the app: the page is read from disk, and the
      // reader's scroll gets to the very end of what is loaded before it
      // answers. Sitting exactly at the end looked like following the live
      // tail, so the page landing dragged the view to ITS end — the reader
      // jumped 500 messages forward, everything they had not read was above
      // them, and they were at an edge again with nothing below.
      const { container } = await seedWindowed();
      const store = useChatStore();

      let guard = 0;
      while (store.newerMessageCount === 0 && guard < 6) {
        const olderBefore = store.olderMessageCount;
        await wheelUntil(
          -1,
          () => store.olderMessageCount < olderBefore,
          'a page of history never loaded',
        );
        guard += 1;
      }
      expect(store.newerMessageCount, 'the tail was never unloaded').toBeGreaterThan(0);

      const release = holdNewerPages();
      await wheelUntil(
        1,
        () => distanceFromBottom(container) <= 2,
        'never reached the end of the window',
      );
      const newerBefore = store.newerMessageCount;
      const firstBefore = store.messages[0].id;
      const lastHeld = store.messages.at(-1)!.id;
      const anchorId = topMessageId(container);
      expect(anchorId).not.toBeNull();
      const offsetOfAnchor = () => {
        const row = container.querySelector<HTMLElement>(`[data-message-id="${anchorId}"]`);
        return row
          ? row.getBoundingClientRect().top - container.getBoundingClientRect().top
          : null;
      };
      const before = offsetOfAnchor()!;

      release();
      await settle(30);

      expect(store.newerMessageCount, 'the held page never arrived').toBeLessThan(newerBefore);
      // The page took the window past its cap, so the oldest rows were
      // unloaded from above the reader as well — the harder half.
      expect(store.messages[0].id, 'the window was not trimmed at the front').not.toBe(firstBefore);
      // Judged by where the row being read sits, to within layout rounding.
      // Not by which row is nearest the top: with that row part-scrolled
      // away, the nearest edge is a near tie between it and the next, decided
      // by a fraction of a pixel.
      const after = offsetOfAnchor();
      expect(after, 'the row being read was unloaded').not.toBeNull();
      expect(Math.abs(after! - before)).toBeLessThan(2);
      // What was the last message is still on screen, with the page below it.
      expect(container.querySelector(`[data-message-id="${lastHeld}"]`)).not.toBeNull();
      expect(distanceFromBottom(container)).toBeGreaterThan(5_000);
    }, 240_000);

    it('goes to the live end of the conversation from the badge', async () => {
      // Scrolling down would only reach the end of what is loaded. Once the
      // tail has been unloaded there is nothing below the window to scroll
      // to, so the badge fetches the end instead of scrolling to it.
      const { container } = await seedWindowed();
      const store = useChatStore();

      let guard = 0;
      while (store.newerMessageCount === 0 && guard < 6) {
        const olderBefore = store.olderMessageCount;
        await wheelUntil(
          -1,
          () => store.olderMessageCount < olderBefore,
          'a page of history never loaded',
        );
        guard += 1;
      }
      expect(store.newerMessageCount, 'the tail was never unloaded').toBeGreaterThan(0);

      const jump = container.closest('.relative')
        ?.querySelector<HTMLElement>('button.bg-primary-500');
      expect(jump?.textContent).toContain('Jump to latest');

      jump!.click();
      await settle(30);

      expect(store.newerMessageCount).toBe(0);
      expect(store.messages.at(-1)?.id).toBe(`msg-${MESSAGE_COUNT - 1}`);
      expect(distanceFromBottom(container)).toBeLessThan(SETTLE_TOLERANCE_PX);
      expect(store.isTailPinned('conv-browser')).toBe(true);
    }, 180_000);

    it('keeps the message being read where it was when a page is prepended', async () => {
      // The reason the list compensates for rows arriving at its front at
      // all: prepending grows the content above the viewport, which would
      // otherwise push what the reader is looking at down the screen by the
      // height of the entire page.
      //
      // The page is prepended through the store rather than by pressing the
      // control, because the control's handler is asynchronous and this is
      // about the geometry, not the plumbing: the paging is covered by the
      // store's own tests. An earlier version did press it and asserted
      // "more than 400 messages are held" — which a 401-message window
      // already satisfied, so it passed while loading nothing at all.
      const { container } = await seedWindowed();
      const store = useChatStore();

      await wheelUp(container, 10, 120, 2);
      await settle(10);
      const anchorId = topMessageId(container);
      expect(anchorId).not.toBeNull();
      const heldBefore = store.messages.length;

      const older = olderMessages();
      const firstHeld = store.messages[0].id;
      const at = older.findIndex((m) => m.id === firstHeld);
      const from = Math.max(0, at - 500);
      store.prependOlderMessages('conv-browser', older.slice(from, at), from);
      await settle(30);

      // A page really arrived, measured against what was held before.
      expect(store.messages.length).toBeGreaterThan(heldBefore + 400);
      // And the reader is still on the same message.
      expect(topMessageId(container)).toBe(anchorId);
    });

    it('keeps the message being read where it was when a page completes a turn the window cut', async () => {
      // The fixture above alternates user and assistant, so every turn is one
      // message and a page boundary can never fall inside one. A real
      // conversation's turns run to dozens of messages, and a page is cut by
      // count, so the window usually opens mid-turn. The turn's header row is
      // keyed by its first message: when the page brings the rest of the
      // turn, the row that was first is replaced by a header with another key.
      // The list read that as a different list and held nothing — the page
      // landed in front of the viewport, the view stayed at the very top, and
      // what the reader had been looking at was pushed below it.
      const whole = messagesFor('cut', 1000).map((message, index) => ({
        ...message,
        // A prompt, then a five-message answer.
        role: (index % 6 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      }));
      // 503 is the fifth message of the answer that starts at 499.
      const cutAt = 503;
      const store = useChatStore();
      store.setCurrentConversation('conv-browser');
      store.loadMessages(whole.slice(cutAt), cutAt);

      const { container } = await mountList();
      await wheelUp(container, 10, 120, 2);
      await settle(10);
      const anchorId = topMessageId(container);
      expect(anchorId).not.toBeNull();

      store.prependOlderMessages('conv-browser', whole.slice(3, cutAt), 3);
      await settle(30);

      expect(store.messages[0].id).toBe('cut-3');
      expect(topMessageId(container)).toBe(anchorId);
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
  // =========================================================================
  // Jumping to a search hit
  // =========================================================================
  describe('jumping to a search hit', () => {
    /** Whether the message's row is inside the viewport, and highlighted. */
    function shown(container: HTMLElement, id: string): { visible: boolean; flashed: boolean } {
      const row = container.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
      if (!row) return { visible: false, flashed: false };
      const r = row.getBoundingClientRect();
      const c = container.getBoundingClientRect();
      return {
        visible: r.bottom > c.top && r.top < c.bottom,
        flashed: row.classList.contains('search-hit-flash'),
      };
    }

    it('lands on a loaded message far above the view', async () => {
      seedConversation();
      const { wrapper, container } = await mountList();
      const target = 'msg-40';

      await (wrapper.vm as unknown as { scrollToMessage: (id: string) => Promise<void> })
        .scrollToMessage(target);
      // Long enough for a smooth scroll to have finished, had it survived.
      await settle(90);

      expect(shown(container, target)).toEqual({ visible: true, flashed: true });
    });

    it('lands on a loaded message in a conversation held as a window', async () => {
      seedWindowedConversation();
      const { wrapper, container } = await mountList();
      const target = 'msg-40';

      await (wrapper.vm as unknown as { scrollToMessage: (id: string) => Promise<void> })
        .scrollToMessage(target);
      await settle(90);

      expect(shown(container, target)).toEqual({ visible: true, flashed: true });
    });

    it('lands on a message that is not loaded, by loading the stretch around it', async () => {
      seedWindowedConversation();
      const { wrapper, container } = await mountList();
      const store = useChatStore();
      const target = 'older-700';
      expect(store.messages.some((m) => m.id === target), 'the hit is already loaded').toBe(false);

      await useConversationsStore().revealMessage('conv-browser', target);
      await settle(10);
      await (wrapper.vm as unknown as { scrollToMessage: (id: string) => Promise<void> })
        .scrollToMessage(target);
      await settle(90);

      expect(shown(container, target)).toEqual({ visible: true, flashed: true });
      // Still a window: the stretch around the hit, not everything up to it.
      expect(store.messages.length).toBeLessThanOrEqual(WINDOW_MAX);
      expect(store.olderMessageCount + store.messages.length + store.newerMessageCount)
        .toBe(OLDER_COUNT + MESSAGE_COUNT);
    });
  });
  // =========================================================================
  // A message arriving while the user is reading history
  // =========================================================================
  describe('a message arriving while scrolled away', () => {
    /**
     * The case to get right: someone is reading back through a conversation
     * and a turn lands. Their place must not move, they must be told, and
     * they must be able to get back to the end — and none of that may be
     * disturbed by the window being a window.
     */

    /**
     * The badge offering the way back to the newest message.
     *
     * Selected by its own colour class rather than by being "the button":
     * back when a page of history was loaded by pressing a control, that
     * control was a pill-shaped button too, and a looser selector matched it
     * instead — which is how this test once reported the badge saying "Load
     * earlier messages (999)". The control is gone, the lesson is not.
     */
    function badge(container: HTMLElement): HTMLElement | null {
      const root = container.closest('.relative') ?? container.parentElement;
      return root?.querySelector<HTMLElement>('button.bg-primary-500') ?? null;
    }

    function arrive(id: string, content = 'a new answer'): void {
      useChatStore().addMessage({
        id, role: 'assistant', content, timestamp: Date.now(),
      });
    }

    it('does not move what the user is reading', async () => {
      seedConversation();
      const { container } = await mountList();
      await wheelUp(container, 12, 120, 2);

      const anchor = topRowElement(container);
      if (!anchor) throw new Error('no row to anchor on');
      const anchorId = anchor.dataset.messageId;
      const offsetBefore = anchor.getBoundingClientRect().top
        - container.getBoundingClientRect().top;

      arrive('arrived-1');
      await settle(20);

      const after = container.querySelector<HTMLElement>(`[data-message-id="${anchorId}"]`);
      expect(after, 'the row being read is still rendered').not.toBeNull();
      const offsetAfter = after!.getBoundingClientRect().top
        - container.getBoundingClientRect().top;

      expect(Math.abs(offsetAfter - offsetBefore)).toBeLessThan(4);
    });

    it('says how many arrived', async () => {
      seedConversation();
      const { container } = await mountList();
      await wheelUp(container, 12, 120, 2);

      arrive('arrived-1');
      await settle(10);
      expect(badge(container)?.textContent).toContain('1 new message');

      arrive('arrived-2');
      arrive('arrived-3');
      await settle(10);
      expect(badge(container)?.textContent).toContain('3 new messages');
    });

    it('offers no badge while the view is at the end', async () => {
      seedConversation();
      const { container } = await mountList();

      arrive('arrived-1');
      await settle(10);

      expect(badge(container)).toBeNull();
      // And the new message was followed, rather than being counted.
      expect(distanceFromBottom(container)).toBeLessThan(SETTLE_TOLERANCE_PX);
    });

    it('goes back to the newest message when the badge is used', async () => {
      seedConversation();
      const { container } = await mountList();
      await wheelUp(container, 12, 120, 2);
      arrive('arrived-1');
      await settle(10);

      badge(container)?.click();
      await settle(20);

      expect(distanceFromBottom(container)).toBeLessThan(SETTLE_TOLERANCE_PX);
      expect(badge(container)).toBeNull();
    });

    it('does not move the view while an answer streams in', async () => {
      // The row grows below the viewport, repeatedly, which is the case a
      // height-change correction has to leave alone.
      seedConversation();
      const { container } = await mountList();
      await wheelUp(container, 12, 120, 2);

      const anchor = topRowElement(container);
      const anchorId = anchor?.dataset.messageId;
      const offsetBefore = anchor!.getBoundingClientRect().top
        - container.getBoundingClientRect().top;

      const store = useChatStore();
      store.startAssistantMessage('conv-browser');
      for (let i = 0; i < 12; i += 1) {
        store.appendChunk('conv-browser', `streamed chunk ${i}. ${PARAGRAPH}`);
        await settle(2);
      }
      await settle(20);

      const after = container.querySelector<HTMLElement>(`[data-message-id="${anchorId}"]`);
      const offsetAfter = after!.getBoundingClientRect().top
        - container.getBoundingClientRect().top;

      expect(Math.abs(offsetAfter - offsetBefore)).toBeLessThan(4);
    });

    it('counts a message that arrives, not a page of history that is loaded', async () => {
      // The list grows at the front too, now that it is a window. Counting
      // any growth announced "500 new messages" for history the user had
      // asked for themselves.
      seedWindowedConversation();
      const store = useChatStore();
      const { container } = await mountList();
      const heldBefore = store.messages.length;
      const olderBefore = store.olderMessageCount;

      await wheelUntil(
        -1,
        () => store.olderMessageCount < olderBefore,
        'never reached the top of the window',
      );

      // A page really arrived — asserted against what was held before,
      // because "more than the window" is true without loading anything.
      expect(store.messages.length).toBeGreaterThan(heldBefore);
      expect(store.olderMessageCount).toBeLessThan(olderBefore);
      const text = badge(container)?.textContent ?? '';
      expect(text).not.toContain('new message');

      // A real arrival still counts.
      arrive('arrived-after-paging');
      await settle(10);
      expect(badge(container)?.textContent).toContain('1 new message');
    }, 120_000);

    it('does not move the view when a message arrives after paging back', async () => {
      seedWindowedConversation();
      const store = useChatStore();
      const { container } = await mountList();
      const heldBefore = store.messages.length;
      const olderBefore = store.olderMessageCount;
      await wheelUntil(
        -1,
        () => store.olderMessageCount < olderBefore,
        'never reached the top of the window',
      );
      expect(store.messages.length).toBeGreaterThan(heldBefore);

      const anchor = topRowElement(container);
      const anchorId = anchor?.dataset.messageId;
      const offsetBefore = anchor!.getBoundingClientRect().top
        - container.getBoundingClientRect().top;

      arrive('arrived-after-paging');
      await settle(20);

      const after = container.querySelector<HTMLElement>(`[data-message-id="${anchorId}"]`);
      expect(after).not.toBeNull();
      const offsetAfter = after!.getBoundingClientRect().top
        - container.getBoundingClientRect().top;

      expect(Math.abs(offsetAfter - offsetBefore)).toBeLessThan(4);
    }, 120_000);

    it('does not show a turn that arrives after the tail was unloaded', async () => {
      // Read back far enough and the newest messages are unloaded to keep the
      // loaded set bounded. A turn arriving then is held — it has to be, it
      // is what gets saved — but it does not follow the message before it:
      // hundreds sit in between, on disk. Showing it would put the newest
      // answer directly under a message from the middle of the conversation.
      seedWindowedConversation();
      const store = useChatStore();
      const { container } = await mountList();

      let guard = 0;
      while (store.newerMessageCount === 0 && guard < 6) {
        const olderBefore = store.olderMessageCount;
        await wheelUntil(
          -1,
          () => store.olderMessageCount < olderBefore,
          'a page of history never loaded',
        );
        guard += 1;
      }
      expect(store.newerMessageCount, 'the tail was never unloaded').toBeGreaterThan(0);

      const anchor = topRowElement(container);
      const anchorId = anchor?.dataset.messageId;
      const offsetBefore = anchor!.getBoundingClientRect().top
        - container.getBoundingClientRect().top;
      const newerBefore = store.newerMessageCount;

      arrive('arrived-while-reading');
      await settle(20);

      // Not rendered, and not moving the view.
      expect(container.querySelector('[data-message-id="arrived-while-reading"]'))
        .toBeNull();
      const after = container.querySelector<HTMLElement>(`[data-message-id="${anchorId}"]`);
      expect(after, 'the row being read is still rendered').not.toBeNull();
      const offsetAfter = after!.getBoundingClientRect().top
        - container.getBoundingClientRect().top;
      expect(Math.abs(offsetAfter - offsetBefore)).toBeLessThan(4);

      // Counted, and reachable: the badge is the way to it.
      expect(store.newerMessageCount).toBe(newerBefore + 1);
      const jump = container.closest('.relative')
        ?.querySelector<HTMLElement>('button.bg-primary-500');
      expect(jump).not.toBeNull();

      jump!.click();
      await settle(30);

      expect(store.messages.at(-1)?.id).toBe('arrived-while-reading');
      expect(container.querySelector('[data-message-id="arrived-while-reading"]'))
        .not.toBeNull();
      expect(distanceFromBottom(container)).toBeLessThan(SETTLE_TOLERANCE_PX);
    }, 180_000);
  });
});
