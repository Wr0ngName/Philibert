/**
 * Selection attribution, which is what decides whether Copy copies a
 * highlighted fragment or the whole message.
 *
 * Copy previously wrote the entire message content unconditionally, so
 * highlighting one line of a long reply and choosing Copy pasted the whole
 * reply. The fix hinges on these cases, in particular on a selection in
 * *another* message not counting as a selection in this one.
 *
 * Uses real DOM nodes and a hand-built Selection: the test environment does
 * not implement window.getSelection, and the behaviour under test is the
 * containment logic rather than the browser's selection engine.
 */

import { describe, it, expect } from 'vitest';

import { selectionWithin } from '../selection';

/** A Selection over `text`, whose range reports `anchor` as its ancestor. */
function selectionOver(text: string, anchor: Node, ranges = 1): Selection {
  return {
    isCollapsed: false,
    rangeCount: ranges,
    getRangeAt: () => ({ commonAncestorContainer: anchor }) as Range,
    toString: () => text,
  } as unknown as Selection;
}

/** A container with a text child, plus a detached sibling container. */
function fixture() {
  const container = document.createElement('div');
  const inner = document.createElement('span');
  const textNode = document.createTextNode('Second line of the reply.');
  inner.appendChild(textNode);
  container.appendChild(inner);

  const other = document.createElement('div');
  other.appendChild(document.createTextNode('text in a different message'));

  return { container, inner, textNode, other };
}

describe('selectionWithin', () => {
  it('returns the selected text when the selection is inside the container', () => {
    const { container, textNode } = fixture();
    expect(selectionWithin(container, selectionOver('Second line', textNode)))
      .toBe('Second line');
  });

  it('returns the text when the selection spans the container itself', () => {
    // contains() is true for the node itself; a selection covering the whole
    // message still belongs to it.
    const { container } = fixture();
    expect(selectionWithin(container, selectionOver('everything', container)))
      .toBe('everything');
  });

  it('returns null for a selection in a different element', () => {
    // The bug this guards: highlighting text in one message and opening
    // another message's menu must not copy the first one's text.
    const { container, other } = fixture();
    expect(selectionWithin(container, selectionOver('text in a different message', other)))
      .toBeNull();
  });

  it('returns null when there is no selection', () => {
    const { container } = fixture();
    expect(selectionWithin(container, null)).toBeNull();
  });

  it('returns null for a collapsed selection (a caret, not a range)', () => {
    const { container, textNode } = fixture();
    const caret = { ...selectionOver('', textNode), isCollapsed: true } as unknown as Selection;
    expect(selectionWithin(container, caret)).toBeNull();
  });

  it('returns null when there are no ranges', () => {
    const { container, textNode } = fixture();
    const empty = { ...selectionOver('x', textNode), rangeCount: 0 } as unknown as Selection;
    expect(selectionWithin(container, empty)).toBeNull();
  });

  it('returns null for a whitespace-only selection', () => {
    // Dragging slightly past a line end selects whitespace; that should fall
    // back to copying the message, not paste a blank.
    const { container, textNode } = fixture();
    expect(selectionWithin(container, selectionOver('  \n ', textNode))).toBeNull();
  });

  it('preserves the selection verbatim, including newlines', () => {
    const { container, textNode } = fixture();
    expect(selectionWithin(container, selectionOver('line one\nline two', textNode)))
      .toBe('line one\nline two');
  });

  it('rejects a multi-range selection where any range falls outside', () => {
    const { container, textNode, other } = fixture();
    let call = 0;
    const mixed = {
      isCollapsed: false,
      rangeCount: 2,
      // First range inside, second outside — not attributable to this
      // container, so it must not be treated as its selection.
      getRangeAt: () => ({ commonAncestorContainer: call++ === 0 ? textNode : other }) as unknown as Range,
      toString: () => 'partly outside',
    } as unknown as Selection;
    expect(selectionWithin(container, mixed)).toBeNull();
  });
});
