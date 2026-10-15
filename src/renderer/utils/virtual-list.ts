/**
 * Geometry for a virtualised list of variable-height rows.
 *
 * Pure functions, deliberately: the component that uses them cannot be tested
 * for layout (happy-dom has no layout engine, so every height reads as 0), so
 * the arithmetic that decides what gets rendered is kept here where it can be
 * asserted directly.
 *
 * Rows are measured as they render and remembered. A row never yet rendered
 * has no measurement, so it contributes an estimate — which means offsets
 * below the viewport are approximate and firm up as the user scrolls. That is
 * the accepted trade of this approach: the alternative, measuring everything
 * up front, means mounting everything, which is the problem being solved.
 */

/** A half-open window of rows to render, with where to place them. */
export interface VirtualWindow {
  /** First row to render, inclusive. */
  start: number;
  /** One past the last row to render. */
  end: number;
  /** Pixel offset of `start` from the top of the scrolled content. */
  offsetTop: number;
  /** Height of all rows, measured where known and estimated elsewhere. */
  totalHeight: number;
}

/**
 * Cumulative row tops. `offsets[i]` is the top edge of row `i`; the final
 * entry is the total height, so the array has `count + 1` entries.
 */
export function buildOffsets(
  count: number,
  heightAt: (index: number) => number | undefined,
  estimatedHeight: number,
): number[] {
  const offsets = new Array<number>(count + 1);
  offsets[0] = 0;
  for (let i = 0; i < count; i += 1) {
    const measured = heightAt(i);
    // A measured zero is honoured — a row can legitimately render nothing —
    // but undefined means "not yet seen", which is what the estimate is for.
    const height = measured === undefined ? estimatedHeight : measured;
    offsets[i + 1] = offsets[i] + height;
  }
  return offsets;
}

/**
 * Index of the row containing `offset`.
 *
 * Binary search over the cumulative tops, so this stays cheap on a
 * conversation with thousands of rows. Clamped to the last row, so an offset
 * past the end of the content resolves to something renderable rather than
 * out of bounds.
 */
export function findIndexAtOffset(offsets: readonly number[], offset: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return 0;
  if (offset <= 0) return 0;
  if (offset >= offsets[count]) return count - 1;

  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (offsets[mid + 1] <= offset) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * The rows to render for a given scroll position.
 *
 * `overscan` rows are kept either side of the viewport so scrolling does not
 * expose unrendered space before Vue can catch up.
 *
 * Two cases deliberately render everything rather than nothing:
 *   - a viewport of zero or less, which is what an unlaid-out or hidden
 *     container reports. Returning an empty window there would render no
 *     rows, so nothing would ever be measured, so the window would stay
 *     empty — a permanently blank list.
 *   - a non-finite scroll position, which should never happen but must not be
 *     able to blank the conversation if it does.
 */
export function visibleWindow(
  offsets: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): VirtualWindow {
  const count = Math.max(offsets.length - 1, 0);
  const totalHeight = count > 0 ? offsets[count] : 0;

  if (count === 0) {
    return { start: 0, end: 0, offsetTop: 0, totalHeight: 0 };
  }

  if (!Number.isFinite(scrollTop) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return { start: 0, end: count, offsetTop: 0, totalHeight };
  }

  const top = Math.max(0, Math.min(scrollTop, totalHeight));
  const firstVisible = findIndexAtOffset(offsets, top);
  const lastVisible = findIndexAtOffset(offsets, top + viewportHeight);

  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(count, lastVisible + overscan + 1);

  return { start, end, offsetTop: offsets[start], totalHeight };
}

/**
 * How far to move the scroll position to keep what the user is looking at
 * still, after a row above the viewport changed height.
 *
 * Any row above the viewport whose height changes moves everything below it,
 * including what the user is reading. Shifting the scroll position by the same
 * delta cancels that out.
 *
 * `previousHeight` is undefined for a row being measured for the first time,
 * which is the common case when scrolling UP into rows that have never
 * rendered. Those rows were contributing `estimate` to the geometry, so that
 * is what their real height replaces — and skipping this case is what made
 * scrolling up feel stuck: the rows above gained height as they were measured,
 * pushing the content down by roughly as far as the user had just scrolled it
 * up, so slow scrolling went nowhere while fast scrolling outran it.
 *
 * Returns 0 when the change was at or below the anchor, where it is harmless
 * and correcting for it would itself cause a jump.
 */
export function scrollCorrection(
  changedIndex: number,
  anchorIndex: number,
  newHeight: number,
  previousHeight: number | undefined,
  estimate: number,
): number {
  if (changedIndex >= anchorIndex) return 0;
  return newHeight - (previousHeight ?? estimate);
}

/**
 * How far the content moved because rows were added to or removed from the
 * FRONT of the list.
 *
 * Everything else here answers "what should be rendered"; this answers "and
 * where did the rest of it just go". Inserting a page of older messages above
 * the viewport pushes the content the user is reading down by the height of
 * what arrived, and unloading the oldest rows pulls it up by theirs. Neither
 * is a scroll, and neither is a row changing height, so nothing in the list
 * compensated for them — which is how a page of history loaded while reading
 * sent the view hundreds of messages away.
 *
 * Expressed as a pure function of the two key lists and their geometry, so it
 * is decided by arithmetic that can be asserted rather than by measuring a
 * browser:
 *
 *  - rows added at the front: the old first row is now at index `k`, and
 *    everything above it is new, so the content moved down by `next[k]`;
 *  - rows removed from the front: the new first row used to be at index `k`,
 *    so the content moved up by `previous[k]`;
 *  - anything else — appending, inserting or removing mid-list, or no change
 *    at all — moves the front of the list not at all, and returns 0.
 *
 * Returns the number of pixels to add to the scroll offset to leave the
 * content where it was.
 */
export function frontShift(
  previousKeys: readonly string[],
  nextKeys: readonly string[],
  previousOffsets: readonly number[],
  nextOffsets: readonly number[],
): number {
  if (previousKeys.length === 0 || nextKeys.length === 0) return 0;
  if (previousKeys[0] === nextKeys[0]) return 0;

  // Added at the front: where did the row that used to be first go?
  const movedTo = nextKeys.indexOf(previousKeys[0]);
  if (movedTo > 0) return nextOffsets[movedTo] ?? 0;

  // Removed from the front: where did the row that is now first come from?
  const camefrom = previousKeys.indexOf(nextKeys[0]);
  if (camefrom > 0) return -(previousOffsets[camefrom] ?? 0);

  // Neither list's first row appears in the other: this is a different list
  // altogether — a conversation switch — and holding a position across it is
  // not this function's business.
  return 0;
}
