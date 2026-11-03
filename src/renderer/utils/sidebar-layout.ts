/**
 * Where each sidebar goes for a SidebarLayout: which side of the discussion,
 * and its place in the row. The discussions sidebar is always the outermost
 * of the two when they share a side, so switching sides mirrors the row.
 *
 *   left:  discussions | files | chat
 *   split: discussions | chat | files
 *   right: chat | files | discussions
 */

import type { SidebarLayout } from '@shared/types';

export type Side = 'left' | 'right';

export interface SidebarPlace {
  side: Side;
  /** CSS `order` in the row; the discussion is CHAT_ORDER. */
  order: number;
}

export const CHAT_ORDER = 3;

export function sidebarPlaces(layout: SidebarLayout): { history: SidebarPlace; files: SidebarPlace } {
  const historySide: Side = layout === 'right' ? 'right' : 'left';
  const filesSide: Side = layout === 'left' ? 'left' : 'right';
  return {
    history: { side: historySide, order: historySide === 'left' ? CHAT_ORDER - 2 : CHAT_ORDER + 2 },
    files: { side: filesSide, order: filesSide === 'left' ? CHAT_ORDER - 1 : CHAT_ORDER + 1 },
  };
}
