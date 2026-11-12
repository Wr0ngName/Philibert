import { describe, it, expect } from 'vitest';

import { formatMoment } from '../date';
import { lastReceivedLine } from '../last-received';

const NOW = new Date(2026, 10, 12, 18, 58).getTime();

describe('lastReceivedLine', () => {
  it('says when, alone when no background task is running', () => {
    expect(lastReceivedLine(NOW, NOW, 0)).toBe(`Last received ${formatMoment(NOW, NOW)}`);
  });

  it('adds the background tasks still running, singular and plural', () => {
    expect(lastReceivedLine(NOW, NOW, 1)).toBe(`Last received ${formatMoment(NOW, NOW)} · 1 background task still running`);
    expect(lastReceivedLine(NOW, NOW, 3)).toBe(`Last received ${formatMoment(NOW, NOW)} · 3 background tasks still running`);
  });
});
