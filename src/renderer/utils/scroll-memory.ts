/**
 * Where each conversation was left, so switching back returns there.
 *
 * A pixel offset is the wrong thing to remember. Row measurements are
 * discarded when the conversation changes — they belong to one set of rows —
 * so the same content sits at a different offset on the way back, and
 * restoring the number lands somewhere arbitrary. The row is the stable part.
 *
 * "Following the tail" is stored as its own fact rather than inferred from the
 * last row, because the two want different things: a conversation the user was
 * reading should come back to the same message, while one they were following
 * should come back to the newest message, including anything that arrived
 * while they were elsewhere.
 *
 * Lives in a module rather than in the component because the chat view is torn
 * down and rebuilt when the user visits settings, and a position that forgot
 * itself on the way there would be no improvement on not remembering one. One
 * small record per conversation opened in this run of the app; nothing is
 * persisted to disk.
 */

/** A remembered position within one conversation. */
export interface ScrollPosition {
  /** The user was following the newest message. */
  atBottom: boolean;
  /** Stable key of the row under the top of the viewport. */
  rowKey?: string;
  /** How far the viewport top was into that row, in pixels. */
  within?: number;
}

/** Where to put the scroll position when a conversation is shown again. */
export type ScrollTarget =
  | { kind: 'bottom' }
  | { kind: 'row'; index: number; within: number };

const positions = new Map<string, ScrollPosition>();

/** Record where a conversation is currently sitting. */
export function rememberPosition(conversationId: string, position: ScrollPosition): void {
  positions.set(conversationId, position);
}

/** What was recorded for a conversation, if it has been shown before. */
export function recalledPosition(conversationId: string): ScrollPosition | undefined {
  return positions.get(conversationId);
}

/** Drop a conversation's position — on deletion, so the id cannot be reused. */
export function forgetPosition(conversationId: string): void {
  positions.delete(conversationId);
}

/** Start again, for tests. */
export function forgetAllPositions(): void {
  positions.clear();
}

/**
 * Turn a remembered position into somewhere to scroll, given the rows the
 * conversation has now.
 *
 * Falls back to the bottom in all three cases where the memory cannot be
 * honoured — never shown before, was following the tail, or the remembered row
 * is no longer in the list (deleted, or rewound past). The newest message is
 * the right default for a conversation the view has no history with; the one
 * thing it must not do is leave the scroll position where the *previous*
 * conversation happened to be, which is what makes switching feel random.
 */
export function resolveScrollTarget(
  position: ScrollPosition | undefined,
  rowKeys: readonly string[],
): ScrollTarget {
  if (!position || position.atBottom || position.rowKey === undefined) {
    return { kind: 'bottom' };
  }

  const index = rowKeys.indexOf(position.rowKey);
  if (index < 0) return { kind: 'bottom' };

  return { kind: 'row', index, within: position.within ?? 0 };
}
