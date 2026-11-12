import { describe, it, expect } from 'vitest';

import { formatMoment } from '../date';

const NOW = new Date(2026, 10, 12, 9, 0).getTime();
const HOUR = 60 * 60 * 1000;
const TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

describe('formatMoment', () => {
  it('gives the time alone for a moment today', () => {
    const at = NOW + HOUR;
    expect(formatMoment(at, NOW)).toBe(new Date(at).toLocaleTimeString([], TIME));
  });

  it('gives the time alone for a moment earlier today', () => {
    const at = NOW - HOUR;
    expect(formatMoment(at, NOW)).toBe(new Date(at).toLocaleTimeString([], TIME));
  });

  it('adds the date for a moment on another day', () => {
    for (const at of [NOW + 30 * HOUR, NOW - 30 * HOUR]) {
      expect(formatMoment(at, NOW)).toBe(new Date(at).toLocaleString([], { month: 'short', day: 'numeric', ...TIME }));
    }
  });
});
