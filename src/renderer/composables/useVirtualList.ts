/**
 * Renders only the rows a scroll container can actually show.
 *
 * Built for the message list, where rows are variable height, grow while
 * streaming, and appear and disappear in the middle of the list when a
 * sub-agent is expanded. Three consequences shape the design:
 *
 *   - Heights are keyed by a stable row key, never by index. Expanding an
 *     agent inserts rows mid-list, which would shift every index below it and
 *     silently reassign measurements to the wrong rows.
 *   - Rows are measured as they render, through a ResizeObserver, so a row
 *     that grows while streaming keeps its geometry correct without polling.
 *   - When a row above the viewport changes height, the scroll position is
 *     corrected by the same amount. Without that, measuring estimated rows
 *     above the user slides the content they are reading out from under them.
 *
 * It also declines to virtualise at all below a threshold, or where
 * ResizeObserver is missing: a short conversation gains nothing, and without
 * measurement the safe behaviour is to render everything, exactly as before.
 */

import { computed, onUnmounted, ref, type Ref } from 'vue';

import {
  buildOffsets,
  estimateFrom,
  scrollCorrection,
  visibleWindow,
  type VirtualWindow,
} from '../utils/virtual-list';

export interface UseVirtualListOptions {
  /** The scrolling element. */
  container: Ref<HTMLElement | null>;
  /** Stable key per row, in render order. Length is the row count. */
  keys: () => string[];
  /** Height assumed for a row that has never rendered. */
  estimatedHeight?: number;
  /** Rows kept either side of the viewport, to cover fast scrolling. */
  overscan?: number;
  /** Row count below which everything is rendered. */
  threshold?: number;
}

/** A row count below which virtualising costs more than it saves. */
const DEFAULT_THRESHOLD = 60;
const DEFAULT_ESTIMATED_HEIGHT = 72;
const DEFAULT_OVERSCAN = 6;

export function useVirtualList(options: UseVirtualListOptions) {
  const {
    container,
    keys,
    estimatedHeight = DEFAULT_ESTIMATED_HEIGHT,
    overscan = DEFAULT_OVERSCAN,
    threshold = DEFAULT_THRESHOLD,
  } = options;

  /** Measured heights by row key. Survives rows moving within the list. */
  const heights = new Map<string, number>();
  /** Bumped on measurement: a Map mutation is not reactive on its own. */
  const heightsVersion = ref(0);

  const scrollTop = ref(0);
  const viewportHeight = ref(0);

  const measurementAvailable = typeof ResizeObserver !== 'undefined';

  /**
   * Whether to virtualise.
   *
   * The threshold keeps short conversations on the simple path. The
   * ResizeObserver check is the safety valve: with no way to measure, every
   * row would keep its estimate forever and the geometry would drift, so
   * rendering the lot is strictly better than rendering the wrong slice.
   */
  const enabled = computed(() => measurementAvailable && keys().length >= threshold);

  const offsets = computed((): number[] => {
    const rowKeys = keys();
    // Touch the version so measurements invalidate this.
    void heightsVersion.value;
    // Unmeasured rows are estimated from the rows already measured in this
    // conversation, not from a constant: a wrong estimate moves the total
    // height when the real value arrives, and a constant is wrong by a lot
    // when rows range from a one-line tool call to a long answer.
    const estimate = estimateFrom(heights.values(), estimatedHeight);
    return buildOffsets(rowKeys.length, (i) => heights.get(rowKeys[i]), estimate);
  });

  const window = computed((): VirtualWindow => {
    const count = keys().length;
    if (!enabled.value) {
      // Offsets are still built, so the spacer and any scrollToIndex keep
      // working identically on the non-virtualised path.
      return { start: 0, end: count, offsetTop: 0, totalHeight: offsets.value[count] ?? 0 };
    }
    return visibleWindow(offsets.value, scrollTop.value, viewportHeight.value, overscan);
  });

  /** Row elements currently observed, so each can be identified on resize. */
  const observed = new WeakMap<Element, string>();
  let observer: ResizeObserver | null = null;

  function record(key: string, height: number): void {
    const previous = heights.get(key);
    if (previous === height) return;

    heights.set(key, height);
    heightsVersion.value += 1;

    if (previous === undefined || !enabled.value) return;

    // Keep what the user is looking at still. The anchor is the first row in
    // the current window, and only changes strictly above it need cancelling.
    const rowKeys = keys();
    const changedIndex = rowKeys.indexOf(key);
    if (changedIndex === -1) return;

    const correction = scrollCorrection(changedIndex, window.value.start, height - previous);
    if (correction !== 0 && container.value) {
      container.value.scrollTop += correction;
      scrollTop.value = container.value.scrollTop;
    }
  }

  function ensureObserver(): ResizeObserver | null {
    if (!measurementAvailable) return null;
    if (!observer) {
      observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const key = observed.get(entry.target);
          if (key === undefined) continue;
          // offsetHeight rather than contentRect: rows carry padding and
          // borders that are part of the space they occupy.
          record(key, (entry.target as HTMLElement).offsetHeight);
        }
      });
    }
    return observer;
  }

  /**
   * Attach to a rendered row. Pass null when the row unmounts.
   *
   * Intended for a template ref callback, so a row is measured for as long as
   * it is on screen and forgotten — but not unmeasured — when it scrolls away.
   */
  function measureRow(key: string, el: HTMLElement | null): void {
    const active = ensureObserver();
    if (!el) return;

    observed.set(el, key);
    active?.observe(el);
    // Measure immediately as well: ResizeObserver reports the initial size,
    // but not before the first frame, and the window should settle sooner.
    if (el.offsetHeight > 0) record(key, el.offsetHeight);
  }

  function releaseRow(el: HTMLElement | null): void {
    if (!el) return;
    observer?.unobserve(el);
    observed.delete(el);
  }

  /** Track the container's scroll position and height. */
  function syncViewport(): void {
    const el = container.value;
    if (!el) return;
    scrollTop.value = el.scrollTop;
    viewportHeight.value = el.clientHeight;
  }

  /** Forget every measurement — on switching conversation, for instance. */
  function reset(): void {
    heights.clear();
    heightsVersion.value += 1;
    scrollTop.value = 0;
  }

  /** Top offset of a row, for scrolling it into view. */
  function offsetOf(index: number): number {
    const all = offsets.value;
    if (index <= 0) return 0;
    return all[Math.min(index, all.length - 1)];
  }

  onUnmounted(() => {
    observer?.disconnect();
    observer = null;
  });

  return {
    /** Rows to render, and where to put them. */
    window,
    /** Whether virtualisation is actually in effect. */
    enabled,
    measureRow,
    releaseRow,
    syncViewport,
    reset,
    offsetOf,
  };
}
