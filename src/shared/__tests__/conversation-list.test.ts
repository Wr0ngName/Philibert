/**
 * Which discussions are archived, and the order the list is paged in.
 */

import { describe, it, expect } from 'vitest';

import { DAY_MS, isAfter, isArchived, newestFirst, summaryOf } from '../conversation-list';
import type { Conversation } from '../types';

const NOW = Date.UTC(2026, 10, 3);

describe('isArchived', () => {
  it('is never archived by itself when the setting is Never', () => {
    expect(isArchived({ updatedAt: NOW - 1000 * DAY_MS }, 0, NOW)).toBe(false);
  });

  it('archives a discussion without a message for longer than the setting', () => {
    expect(isArchived({ updatedAt: NOW - 31 * DAY_MS }, 30, NOW)).toBe(true);
    expect(isArchived({ updatedAt: NOW - 29 * DAY_MS }, 30, NOW)).toBe(false);
  });

  it('counts being brought back as activity', () => {
    const old = NOW - 100 * DAY_MS;
    expect(isArchived({ updatedAt: old, restoredAt: NOW - DAY_MS }, 30, NOW)).toBe(false);
    expect(isArchived({ updatedAt: old, restoredAt: NOW - 40 * DAY_MS }, 30, NOW)).toBe(true);
  });

  it('keeps one archived by hand archived, whatever the setting, until a message comes after', () => {
    const recent = NOW - DAY_MS;
    expect(isArchived({ updatedAt: recent, archivedAt: NOW }, 0, NOW)).toBe(true);
    expect(isArchived({ updatedAt: recent, archivedAt: NOW }, 30, NOW)).toBe(true);
    // A message after it was archived brings it back.
    expect(isArchived({ updatedAt: NOW + 1, archivedAt: NOW }, 30, NOW)).toBe(false);
  });
});

describe('newestFirst and isAfter', () => {
  it('orders newest first, and by id when two are as new', () => {
    const entries = [
      { id: 'b', updatedAt: 1 },
      { id: 'c', updatedAt: 2 },
      { id: 'a', updatedAt: 1 },
    ];
    expect([...entries].sort(newestFirst).map((e) => e.id)).toEqual(['c', 'a', 'b']);
  });

  it('places an entry after a cursor in that order, ties included', () => {
    const cursor = { id: 'a', updatedAt: 1 };
    expect(isAfter({ id: 'b', updatedAt: 1 }, cursor)).toBe(true);
    expect(isAfter({ id: 'a', updatedAt: 1 }, cursor)).toBe(false);
    expect(isAfter({ id: 'z', updatedAt: 2 }, cursor)).toBe(false);
    expect(isAfter({ id: 'a', updatedAt: 0 }, cursor)).toBe(true);
  });
});

describe('summaryOf', () => {
  it('keeps what the list shows and leaves the messages and session state out', () => {
    const conversation: Conversation = {
      id: 'conv_1',
      title: 'Title',
      customTitle: true,
      workingDirectory: '/project',
      messages: [{ id: 'm', role: 'user', content: 'hi', timestamp: 1 }],
      createdAt: 1,
      updatedAt: 2,
      sdkSessionId: 'session',
      executionMode: 'sdk',
      archivedAt: 3,
    };
    expect(summaryOf(conversation)).toEqual({
      id: 'conv_1',
      title: 'Title',
      customTitle: true,
      workingDirectory: '/project',
      createdAt: 1,
      updatedAt: 2,
      executionMode: 'sdk',
      archivedAt: 3,
    });
  });
});
