/**
 * The clock behind every live duration.
 *
 * Driven through a real mounted component, because what is being tested is
 * lifecycle behaviour: when the interval exists, when it is cleared, and that
 * it survives nothing being on screen.
 */

import { mount } from '@vue/test-utils';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, h, ref } from 'vue';

import { useNowTicker } from '../useNowTicker';

/** A component whose only job is to expose the ticker. */
function host(active: () => boolean) {
  return defineComponent({
    setup() {
      const now = useNowTicker(active);
      return () => h('span', String(now.value));
    },
  });
}

function shown(wrapper: ReturnType<typeof mount>): number {
  return Number(wrapper.text());
}

describe('useNowTicker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('advances once a second while it is wanted', async () => {
    const wrapper = mount(host(() => true));
    const start = shown(wrapper);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(shown(wrapper)).toBe(start + 1_000);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(shown(wrapper)).toBe(start + 3_000);
  });

  it('does not tick while nothing wants it', async () => {
    const wrapper = mount(host(() => false));
    const start = shown(wrapper);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(shown(wrapper)).toBe(start);
  });

  it('starts when something begins to want it, and re-reads the clock at once', async () => {
    // The panel goes from empty to one task; the duration must be right
    // immediately rather than a second later.
    const wanted = ref(false);
    const wrapper = mount(host(() => wanted.value));
    const start = shown(wrapper);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(shown(wrapper)).toBe(start);

    wanted.value = true;
    await vi.advanceTimersByTimeAsync(0);
    expect(shown(wrapper)).toBe(start + 4_000);
  });

  it('stops when it is no longer wanted', async () => {
    const wanted = ref(true);
    const wrapper = mount(host(() => wanted.value));

    await vi.advanceTimersByTimeAsync(1_000);
    wanted.value = false;
    await vi.advanceTimersByTimeAsync(0);
    const stoppedAt = shown(wrapper);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(shown(wrapper)).toBe(stoppedAt);
  });

  it('clears its interval when the component goes away', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const wrapper = mount(host(() => true));

    wrapper.unmount();

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('re-reads the clock when the window becomes visible again', async () => {
    // Chromium throttles timers in a hidden window to about one wake-up a
    // minute, so without this a restored window shows a stale duration until
    // the throttled timer happens to fire.
    const wrapper = mount(host(() => true));
    const start = shown(wrapper);

    // Time passes with no timer firing, which is what throttling looks like.
    vi.setSystemTime(start + 45_000);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);

    expect(shown(wrapper)).toBe(start + 45_000);
  });

  it('stops listening for visibility once the component goes away', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const wrapper = mount(host(() => true));

    wrapper.unmount();

    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    removeSpy.mockRestore();
  });
});
