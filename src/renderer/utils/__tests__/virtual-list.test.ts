/**
 * Virtual list geometry.
 *
 * These are the only part of virtualised rendering that can be verified
 * automatically: happy-dom has no layout engine, so every height in a mounted
 * component reads as 0 and the real behaviour cannot be exercised in a test.
 * The arithmetic therefore lives in pure functions and is pinned here,
 * including the degenerate cases that would otherwise show the user a blank
 * conversation.
 */

import { describe, it, expect } from 'vitest';

import {
  buildOffsets,
  findIndexAtOffset,
  scrollCorrection,
  visibleWindow,
  frontAnchor,
  frontShift,
} from '../virtual-list';

/** Heights keyed by index, for rows that have been measured. */
function measured(map: Record<number, number>) {
  return (index: number) => map[index];
}

describe('buildOffsets', () => {
  it('uses the estimate for rows never measured', () => {
    expect(buildOffsets(3, () => undefined, 50)).toEqual([0, 50, 100, 150]);
  });

  it('uses measurements where it has them', () => {
    expect(buildOffsets(3, measured({ 0: 10, 1: 20, 2: 30 }), 50)).toEqual([0, 10, 30, 60]);
  });

  it('mixes measured and estimated rows', () => {
    // Row 1 has never rendered, so it contributes the estimate.
    expect(buildOffsets(3, measured({ 0: 10, 2: 30 }), 50)).toEqual([0, 10, 60, 90]);
  });

  it('honours a measured height of zero', () => {
    // A row can legitimately render nothing; that is not the same as unmeasured.
    expect(buildOffsets(2, measured({ 0: 0, 1: 0 }), 50)).toEqual([0, 0, 0]);
  });

  it('returns a single zero for an empty list', () => {
    expect(buildOffsets(0, () => undefined, 50)).toEqual([0]);
  });
});

describe('findIndexAtOffset', () => {
  const offsets = [0, 100, 200, 300, 400]; // four rows, 100 each

  it('finds the row at an offset', () => {
    expect(findIndexAtOffset(offsets, 0)).toBe(0);
    expect(findIndexAtOffset(offsets, 50)).toBe(0);
    expect(findIndexAtOffset(offsets, 100)).toBe(1);
    expect(findIndexAtOffset(offsets, 250)).toBe(2);
  });

  it('treats a boundary as the start of the next row', () => {
    expect(findIndexAtOffset(offsets, 200)).toBe(2);
  });

  it('clamps below zero to the first row', () => {
    expect(findIndexAtOffset(offsets, -500)).toBe(0);
  });

  it('clamps past the end to the last row', () => {
    // Must stay in bounds: the caller renders whatever index comes back.
    expect(findIndexAtOffset(offsets, 400)).toBe(3);
    expect(findIndexAtOffset(offsets, 99999)).toBe(3);
  });

  it('returns 0 for an empty list', () => {
    expect(findIndexAtOffset([0], 42)).toBe(0);
  });

  it('skips zero-height rows rather than returning one', () => {
    // Rows 1 and 2 are zero-height, so offset 100 belongs to row 3.
    expect(findIndexAtOffset([0, 100, 100, 100, 200], 100)).toBe(3);
  });
});

describe('visibleWindow', () => {
  const offsets = buildOffsets(100, () => 100, 100); // 100 rows of 100px

  it('renders only what the viewport covers, plus overscan', () => {
    const win = visibleWindow(offsets, 1000, 500, 2);
    // Viewport covers rows 10..15; overscan widens it by 2 each way.
    expect(win.start).toBe(8);
    expect(win.end).toBe(18);
    expect(win.offsetTop).toBe(800);
    expect(win.totalHeight).toBe(10_000);
  });

  it('does not run off the top', () => {
    const win = visibleWindow(offsets, 0, 500, 5);
    expect(win.start).toBe(0);
    expect(win.offsetTop).toBe(0);
  });

  it('does not run off the bottom', () => {
    const win = visibleWindow(offsets, 9_600, 500, 5);
    expect(win.end).toBe(100);
  });

  it('reports the full height regardless of the window', () => {
    // The spacer depends on this, so the scrollbar reflects the whole
    // conversation rather than just the rendered slice.
    expect(visibleWindow(offsets, 5_000, 300, 1).totalHeight).toBe(10_000);
  });

  it('renders everything when the viewport has no height', () => {
    // What an unlaid-out or hidden container reports. An empty window here
    // would render no rows, so nothing would be measured, so the window would
    // stay empty — a conversation that is permanently blank.
    const win = visibleWindow(offsets, 0, 0, 2);
    expect(win.start).toBe(0);
    expect(win.end).toBe(100);
  });

  it('renders everything for a negative viewport', () => {
    const win = visibleWindow(offsets, 0, -10, 2);
    expect(win.end).toBe(100);
  });

  it('renders everything rather than nothing for a non-finite scroll position', () => {
    expect(visibleWindow(offsets, Number.NaN, 500, 2).end).toBe(100);
    expect(visibleWindow(offsets, Number.POSITIVE_INFINITY, 500, 2).end).toBe(100);
  });

  it('returns an empty window for an empty list', () => {
    expect(visibleWindow([0], 0, 500, 2)).toEqual({
      start: 0,
      end: 0,
      offsetTop: 0,
      totalHeight: 0,
    });
  });

  it('clamps a scroll position past the content', () => {
    // Can happen transiently when rows shrink under the viewport.
    const win = visibleWindow(offsets, 50_000, 500, 2);
    expect(win.end).toBe(100);
    expect(win.start).toBeLessThan(100);
  });

  it('handles a viewport taller than the content', () => {
    const short = buildOffsets(3, () => 100, 100);
    const win = visibleWindow(short, 0, 5_000, 2);
    expect(win.start).toBe(0);
    expect(win.end).toBe(3);
  });
});

describe('scrollCorrection', () => {
  it('compensates for an already-measured row above the anchor growing', () => {
    // 100 → 140 pushes everything below down by 40.
    expect(scrollCorrection(3, 10, 140, 100, 72)).toBe(40);
  });

  it('compensates for an already-measured row above the anchor shrinking', () => {
    expect(scrollCorrection(3, 10, 60, 100, 72)).toBe(-40);
  });

  it('compensates for a row measured for the FIRST time above the anchor', () => {
    // This is the case that made scrolling up feel stuck. The row was
    // contributing the estimate (72); its real height is 200, so the content
    // below it — including what the user is reading — drops by 128 unless the
    // scroll position follows.
    expect(scrollCorrection(3, 10, 200, undefined, 72)).toBe(128);
  });

  it('corrects nothing when a first measurement matches the estimate', () => {
    expect(scrollCorrection(3, 10, 72, undefined, 72)).toBe(0);
  });

  it('corrects downward when a first measurement is shorter than the estimate', () => {
    expect(scrollCorrection(3, 10, 40, undefined, 72)).toBe(-32);
  });

  it('ignores a change at the anchor itself', () => {
    // The anchor growing is the row the user is reading changing size, which
    // is expected; correcting for it would itself move the content.
    expect(scrollCorrection(10, 10, 140, 100, 72)).toBe(0);
  });

  it('ignores a change below the anchor', () => {
    expect(scrollCorrection(50, 10, 140, 100, 72)).toBe(0);
    expect(scrollCorrection(50, 10, 200, undefined, 72)).toBe(0);
  });
});

/**
 * Rows arriving at or leaving the front of the list.
 *
 * A page of older messages is inserted above everything on screen, and the
 * oldest rows are unloaded when the window slides. Neither is a scroll and
 * neither is a row changing height, so nothing compensated for them — a page
 * loaded while reading moved the view hundreds of messages. This is the
 * arithmetic that cancels it.
 */
describe('frontShift', () => {
  /** Offsets for rows of a fixed height, as the list builds them. */
  function offsets(count: number, height = 100): number[] {
    return Array.from({ length: count + 1 }, (_unused, i) => i * height);
  }

  function keys(from: number, to: number): string[] {
    const out: string[] = [];
    for (let i = from; i < to; i += 1) out.push(`row-${i}`);
    return out;
  }

  it('is zero when nothing changed', () => {
    const k = keys(0, 5);
    expect(frontShift(k, k, offsets(5), offsets(5))).toBe(0);
  });

  it('is zero when rows were appended', () => {
    // The common case: a turn arrives. The front of the list did not move.
    expect(frontShift(keys(0, 5), keys(0, 8), offsets(5), offsets(8))).toBe(0);
  });

  it('is the height of a page inserted at the front', () => {
    // 3 rows of 100px arrived above everything, so the content moved down
    // 300px and the scroll offset has to follow it.
    expect(frontShift(keys(3, 8), keys(0, 8), offsets(5), offsets(8))).toBe(300);
  });

  it('uses the new geometry for the inserted rows', () => {
    // The rows that arrived have never rendered, so they carry the estimate —
    // which is exactly what the list's own offsets say, and the only thing
    // that matches what it just laid out.
    const nextOffsets = [0, 72, 144, 216, 316, 416];
    expect(frontShift(keys(3, 6), keys(0, 6), offsets(3), nextOffsets)).toBe(216);
  });

  it('is negative when the front of the list was unloaded', () => {
    // Two rows dropped from the front: the content moved up by their height.
    expect(frontShift(keys(0, 8), keys(2, 8), offsets(8), offsets(6))).toBe(-200);
  });

  it('uses the old geometry for the rows that went', () => {
    // They had been rendered, so their measured heights are what left.
    const previousOffsets = [0, 300, 450, 550, 650];
    expect(frontShift(keys(0, 4), keys(2, 4), previousOffsets, offsets(2))).toBe(-450);
  });

  it('is zero for an insertion in the middle', () => {
    // Expanding a sub-agent inserts rows mid-list; nothing above the viewport
    // moved, and the row-resize path handles the rest.
    const previous = ['a', 'b', 'c'];
    const next = ['a', 'b', 'b1', 'b2', 'c'];
    expect(frontShift(previous, next, offsets(3), offsets(5))).toBe(0);
  });

  it('is zero for a removal in the middle', () => {
    const previous = ['a', 'b', 'b1', 'c'];
    const next = ['a', 'b', 'c'];
    expect(frontShift(previous, next, offsets(4), offsets(3))).toBe(0);
  });

  it('is zero for an unrelated list', () => {
    // A different conversation. Holding a position across that is the restore
    // path's job, and guessing here would fight it.
    expect(frontShift(keys(0, 4), ['x', 'y', 'z'], offsets(4), offsets(3))).toBe(0);
  });

  it('is zero when either list is empty', () => {
    expect(frontShift([], keys(0, 3), [0], offsets(3))).toBe(0);
    expect(frontShift(keys(0, 3), [], offsets(3), [0])).toBe(0);
  });

  it('cancels a prepend exactly, so the content stays put', () => {
    // The property the whole thing exists for, stated as arithmetic: the row
    // the user was looking at sits at the same distance below the scroll
    // offset before and after.
    const previousKeys = keys(5, 15);
    const nextKeys = keys(0, 15);
    const previous = offsets(10);
    const next = offsets(15);

    const scrollTopBefore = 250; // 2.5 rows into the old list
    const rowBefore = previousKeys[2];
    const offsetOfRowBefore = previous[2];

    const shift = frontShift(previousKeys, nextKeys, previous, next);
    const scrollTopAfter = scrollTopBefore + shift;
    const offsetOfRowAfter = next[nextKeys.indexOf(rowBefore)];

    expect(scrollTopAfter - offsetOfRowAfter).toBe(scrollTopBefore - offsetOfRowBefore);
  });

  /*
   * A page boundary falls by message count, so it routinely lands inside an
   * assistant turn. The turn's header row is keyed by the turn's FIRST
   * message, so when the earlier half of the turn arrives the old first row
   * (`a5:header`) is replaced by `a1:header` and appears nowhere in the new
   * list. Looking only for the old first row read that as an unrelated list
   * and returned 0: the page landed in front of the viewport uncompensated,
   * the view stayed at the very top, and what the reader had been looking at
   * was pushed down below it.
   */
  it('is the height of a page that completed a turn cut at the front', () => {
    const previousKeys = ['a5:header', 'a5', 'a6', 'u7'];
    const nextKeys = ['u0', 'a1:header', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'u7'];
    // a5 sat 40px down (under a 40px header) and now sits under six 100px rows.
    const previous = [0, 40, 140, 240, 340];
    const next = offsets(9);

    expect(frontShift(previousKeys, nextKeys, previous, next)).toBe(600 - 40);
  });

  it('is the height that went when an unload cut a turn at the front', () => {
    const previousKeys = ['u0', 'a1:header', 'a1', 'a2', 'a3', 'u4'];
    const nextKeys = ['a2:header', 'a2', 'a3', 'u4'];
    const previous = offsets(6);
    const next = [0, 40, 140, 240, 340];

    // a2 was 300px down and is now 40px down.
    expect(frontShift(previousKeys, nextKeys, previous, next)).toBe(40 - 300);
  });
});

/**
 * Which row both lists still share at the front: the row the content is held
 * against, and the boundary between rows that arrived in front of it and the
 * rest.
 */
describe('frontAnchor', () => {
  it('is null when the front did not change', () => {
    expect(frontAnchor(['a', 'b'], ['a', 'b', 'c'])).toBeNull();
  });

  it('is null for an unrelated list', () => {
    expect(frontAnchor(['a', 'b'], ['x', 'y'])).toBeNull();
  });

  it('is null when either list is empty', () => {
    expect(frontAnchor([], ['a'])).toBeNull();
    expect(frontAnchor(['a'], [])).toBeNull();
  });

  it('finds the old first row after a prepend', () => {
    expect(frontAnchor(['c', 'd'], ['a', 'b', 'c', 'd'])).toEqual({ previousIndex: 0, nextIndex: 2 });
  });

  it('finds the new first row after an unload', () => {
    expect(frontAnchor(['a', 'b', 'c'], ['c'])).toEqual({ previousIndex: 2, nextIndex: 0 });
  });

  it('skips a first row whose key did not survive', () => {
    expect(frontAnchor(['a5:header', 'a5'], ['a1:header', 'a1', 'a5'])).toEqual({
      previousIndex: 1,
      nextIndex: 2,
    });
  });
});
