/**
 * Remembered scroll positions.
 *
 * The store itself is a Map and needs little proving; `resolveScrollTarget` is
 * where the behaviour lives, and every one of its branches is a case the user
 * actually hit — switching into a conversation and landing somewhere arbitrary,
 * or not following the tail of one that was being followed.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  forgetAllPositions,
  forgetPosition,
  recalledPosition,
  rememberPosition,
  resolveScrollTarget,
} from '../scroll-memory';

const ROWS = ['a', 'b', 'c', 'd'];

describe('remembering positions', () => {
  beforeEach(() => {
    forgetAllPositions();
  });

  it('recalls what was recorded for a conversation', () => {
    rememberPosition('conv-1', { atBottom: false, rowKey: 'b', within: 12 });
    expect(recalledPosition('conv-1')).toEqual({ atBottom: false, rowKey: 'b', within: 12 });
  });

  it('keeps conversations apart', () => {
    rememberPosition('conv-1', { atBottom: true });
    rememberPosition('conv-2', { atBottom: false, rowKey: 'c', within: 0 });

    expect(recalledPosition('conv-1')).toEqual({ atBottom: true });
    expect(recalledPosition('conv-2')?.rowKey).toBe('c');
  });

  it('recalls nothing for a conversation never shown', () => {
    expect(recalledPosition('conv-unseen')).toBeUndefined();
  });

  it('replaces an earlier position rather than accumulating', () => {
    rememberPosition('conv-1', { atBottom: false, rowKey: 'b', within: 12 });
    rememberPosition('conv-1', { atBottom: true });
    expect(recalledPosition('conv-1')).toEqual({ atBottom: true });
  });

  it('forgets a deleted conversation', () => {
    rememberPosition('conv-1', { atBottom: true });
    forgetPosition('conv-1');
    expect(recalledPosition('conv-1')).toBeUndefined();
  });
});

describe('resolveScrollTarget', () => {
  it('goes to the bottom for a conversation never shown', () => {
    // The important half of this is what it must NOT do: leave the scroll
    // position where the previous conversation was.
    expect(resolveScrollTarget(undefined, ROWS)).toEqual({ kind: 'bottom' });
  });

  it('goes to the bottom for a conversation that was following the tail', () => {
    // Deliberately the live bottom, not the row that was last at the bottom,
    // so messages that arrived while the user was elsewhere are visible.
    expect(resolveScrollTarget({ atBottom: true }, ROWS)).toEqual({ kind: 'bottom' });
  });

  it('returns to the remembered row', () => {
    expect(resolveScrollTarget({ atBottom: false, rowKey: 'c', within: 20 }, ROWS)).toEqual({
      kind: 'row',
      index: 2,
      within: 20,
    });
  });

  it('treats a missing offset within the row as the top of it', () => {
    expect(resolveScrollTarget({ atBottom: false, rowKey: 'c' }, ROWS)).toEqual({
      kind: 'row',
      index: 2,
      within: 0,
    });
  });

  it('falls back to the bottom when the remembered row is gone', () => {
    // Deleted, or rewound past. Scrolling to a row that is not there would
    // leave the position wherever it already was.
    expect(resolveScrollTarget({ atBottom: false, rowKey: 'z', within: 20 }, ROWS)).toEqual({
      kind: 'bottom',
    });
  });

  it('falls back to the bottom for a position with no row at all', () => {
    expect(resolveScrollTarget({ atBottom: false }, ROWS)).toEqual({ kind: 'bottom' });
  });

  it('falls back to the bottom when the conversation has no rows', () => {
    expect(resolveScrollTarget({ atBottom: false, rowKey: 'c', within: 20 }, [])).toEqual({
      kind: 'bottom',
    });
  });

  it('returns the first row when that is what was remembered', () => {
    // Index 0 is a real answer and must not be confused with "not found".
    expect(resolveScrollTarget({ atBottom: false, rowKey: 'a', within: 5 }, ROWS)).toEqual({
      kind: 'row',
      index: 0,
      within: 5,
    });
  });
});
