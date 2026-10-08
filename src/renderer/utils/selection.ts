/**
 * Reading the document selection in a way that can be attributed to one
 * element.
 *
 * "Is anything selected" is not a useful question on its own: a selection
 * somewhere else on the page would answer yes, and copying it from a different
 * message's menu would be wrong. Every helper here therefore asks whether the
 * selection lies *within* a given container.
 */

/**
 * The selected text, but only when the whole selection sits inside
 * `container`. Returns null when nothing is selected, when the selection is
 * collapsed (a caret, not a range), when it is only whitespace, or when any
 * part of it falls outside the container.
 *
 * A multi-range selection — possible on some platforms — counts only if every
 * range is inside, since a partially-outside selection cannot be attributed to
 * this container.
 */
export function selectionWithin(
  container: Node,
  selection: Selection | null = typeof window === 'undefined' ? null : window.getSelection(),
): string | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    // `contains` is true for the node itself, which is what we want: a
    // selection spanning the whole container still belongs to it.
    if (!container.contains(range.commonAncestorContainer)) return null;
  }

  const text = selection.toString();
  return text.trim() ? text : null;
}
