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
 * Height to assume for a row that has never rendered.
 *
 * The mean of what has actually been measured, falling back to `fallback`
 * until something has. A constant is a poor guess here — a one-line tool row
 * and a long answer differ by an order of magnitude — and every wrong guess
 * moves the total height when the real value arrives, which churns the
 * scrollbar and shifts rows below the correction. Estimating from this
 * conversation's own rows keeps that movement small.
 */
export function estimateFrom(measuredHeights: Iterable<number>, fallback: number): number {
  let sum = 0;
  let count = 0;
  for (const height of measuredHeights) {
    sum += height;
    count += 1;
  }
  return count > 0 ? sum / count : fallback;
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
 * still, after rows above the viewport changed height.
 *
 * Measuring a row that was previously an estimate moves everything below it.
 * When that row is above the viewport the content the user is reading slides
 * under them, which during streaming happens continuously. Shifting the
 * scroll position by the same delta cancels it out.
 *
 * Returns 0 when the change was at or below the anchor, where it is harmless
 * and correcting for it would itself cause a jump.
 */
export function scrollCorrection(
  changedIndex: number,
  anchorIndex: number,
  heightDelta: number,
): number {
  if (changedIndex >= anchorIndex) return 0;
  return heightDelta;
}
