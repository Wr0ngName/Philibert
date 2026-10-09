/**
 * The short model label used on the selector chip.
 *
 * The chip has roughly 150px and truncates. It used to show the menu row's
 * own displayName, which starts with "Claude" — so "Claude Opus 5.5" rendered
 * as "Claude Opus…" and cut the version, the one part the user had just
 * chosen and the only part that distinguishes it from its siblings. The chip
 * now uses the short form, which carries the version in the space available.
 *
 * These pin the formatter the chip relies on; the component picks between it
 * and the family name depending on whether the selection parses as a version.
 */

import { describe, it, expect } from 'vitest';

import { capitalizeFamily, familyKeyOf, formatModelId, parseModelId } from '../model-id';

/** What ModelSelector computes for the chip, kept in step with the component. */
function chipLabel(selection: string): string {
  if (parseModelId(selection)) return formatModelId(selection);
  const family = familyKeyOf(selection);
  return family ? capitalizeFamily(family) : selection;
}

describe('chip label', () => {
  it('keeps the version and drops the redundant "Claude" prefix', () => {
    // "Claude Opus 5.5" is 15 chars and truncated to "Claude Opus"; this is 8.
    expect(chipLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(chipLabel('claude-opus-4-8')).toBe('Opus 4.8');
    expect(chipLabel('claude-sonnet-5')).toBe('Sonnet 5');
  });

  it('is short enough that the version survives the chip', () => {
    // The failure was a long label being cut at the wrong end. Nothing here
    // should approach the width that caused it.
    for (const id of ['claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-4-5', 'claude-sonnet-4-6']) {
      expect(chipLabel(id).length).toBeLessThanOrEqual(12);
    }
  });

  it('keeps the version through a context variant or dated snapshot', () => {
    // Both suffixes are part of the stored selection but not of the name.
    expect(chipLabel('claude-opus-5-5[1m]')).toBe('Opus 5.5');
    expect(chipLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
  });

  it('falls back to the family for an alias selection', () => {
    // Alias rows carry no version to show.
    expect(chipLabel('opus')).toBe('Opus');
    expect(chipLabel('opus[1m]')).toBe('Opus');
    expect(chipLabel('sonnet')).toBe('Sonnet');
  });

  it('returns an unrecognisable selection unchanged rather than blanking it', () => {
    expect(chipLabel('something-else')).toBe('something-else');
  });
});
