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
