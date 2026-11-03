/**
 * Each layout puts the sidebars where its name says, with discussions the
 * outermost when the two share a side.
 */

import { describe, it, expect } from 'vitest';

import type { SidebarLayout } from '@shared/types';
import { DEFAULT_CONFIG } from '@shared/types';

import { CHAT_ORDER, sidebarPlaces } from '../sidebar-layout';

/** The row as it is drawn, left to right. */
function row(layout: SidebarLayout): string[] {
  const { history, files } = sidebarPlaces(layout);
  return [
    { name: 'discussions', order: history.order },
    { name: 'files', order: files.order },
    { name: 'chat', order: CHAT_ORDER },
  ]
    .sort((a, b) => a.order - b.order)
    .map((item) => item.name);
}

describe('sidebarPlaces', () => {
  it('left: both sidebars left of the discussion, discussions outermost', () => {
    expect(row('left')).toEqual(['discussions', 'files', 'chat']);
    expect(sidebarPlaces('left').history.side).toBe('left');
    expect(sidebarPlaces('left').files.side).toBe('left');
  });

  it('split: discussions left, files right', () => {
    expect(row('split')).toEqual(['discussions', 'chat', 'files']);
    expect(sidebarPlaces('split').history.side).toBe('left');
    expect(sidebarPlaces('split').files.side).toBe('right');
  });

  it('right: both sidebars right of the discussion, discussions outermost', () => {
    expect(row('right')).toEqual(['chat', 'files', 'discussions']);
    expect(sidebarPlaces('right').history.side).toBe('right');
    expect(sidebarPlaces('right').files.side).toBe('right');
  });

  it('puts the discussion in the middle by default', () => {
    expect(DEFAULT_CONFIG.sidebarLayout).toBe('split');
  });
});
