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

  describe('with a usage limit waited on', () => {
    // The turn the limit stopped: its last message.
    const STOPPED = NOW - 10 * DAY_MS;

    it('continues before archiving even when the wait is as long as the archive delay', () => {
      // Stopped, reset a week later, continued 90 seconds after that: the
      // last moment a week-long wait allows, with a week's archive delay.
      const resumeAt = STOPPED + 7 * DAY_MS + 90_000;
      const wait = { resetsAt: STOPPED + 7 * DAY_MS, resumeAt };
      const conversation = { updatedAt: STOPPED, usageLimitWait: wait };
      // Without the wait, archived before the continue comes due.
      expect(isArchived({ updatedAt: STOPPED }, 7, resumeAt)).toBe(true);
      expect(isArchived(conversation, 7, resumeAt)).toBe(false);
      expect(isArchived(conversation, 7, resumeAt + 7 * DAY_MS - 1)).toBe(false);
    });

    it('counts an offered wait from the reset, when the user can continue it', () => {
      const wait = { resetsAt: STOPPED + 2 * DAY_MS, resumeAt: null };
      expect(isArchived({ updatedAt: STOPPED, usageLimitWait: wait }, 7, STOPPED + 9 * DAY_MS - 1)).toBe(false);
      expect(isArchived({ updatedAt: STOPPED, usageLimitWait: wait }, 7, STOPPED + 9 * DAY_MS + 1)).toBe(true);
    });

    it('leaves a missed continue the archive delay from when the user was told, and no longer', () => {
      const missedAt = STOPPED + 20 * DAY_MS;
      const wait = { resetsAt: STOPPED + DAY_MS, resumeAt: null, missedAt };
      const conversation = { updatedAt: STOPPED, usageLimitWait: wait };
      expect(isArchived(conversation, 7, missedAt + 7 * DAY_MS - 1)).toBe(false);
      expect(isArchived(conversation, 7, missedAt + 7 * DAY_MS + 1)).toBe(true);
    });

    it('never keeps a discussion out of the archive for good: a wait only moves where the days count from', () => {
      const waits = [
        { resetsAt: STOPPED + DAY_MS, resumeAt: STOPPED + DAY_MS + 30_000 },
        { resetsAt: STOPPED + DAY_MS, resumeAt: null },
        { resetsAt: STOPPED + DAY_MS, resumeAt: null, missedAt: STOPPED + 3 * DAY_MS },
      ];
      for (const usageLimitWait of waits) {
        expect(isArchived({ updatedAt: STOPPED, usageLimitWait }, 7, STOPPED + 365 * DAY_MS)).toBe(true);
      }
    });

    it('does not bring back one with older activity than its last message', () => {
      // A wait that counts from before the last message changes nothing.
      const wait = { resetsAt: STOPPED - DAY_MS, resumeAt: null };
      expect(isArchived({ updatedAt: STOPPED, usageLimitWait: wait }, 7, STOPPED + 7 * DAY_MS + 1)).toBe(true);
    });

    it('does not keep out of the archive one archived by hand, or whose session is gone', () => {
      const wait = { resetsAt: NOW + DAY_MS, resumeAt: NOW + DAY_MS + 30_000 };
      expect(isArchived({ updatedAt: STOPPED, archivedAt: NOW, usageLimitWait: wait }, 7, NOW)).toBe(true);
      expect(isArchived({ updatedAt: NOW, sessionGone: true, usageLimitWait: wait }, 7, NOW)).toBe(true);
    });

    it('archives nothing when the setting is Never, wait or not', () => {
      const wait = { resetsAt: STOPPED, resumeAt: null, missedAt: STOPPED };
      expect(isArchived({ updatedAt: STOPPED, usageLimitWait: wait }, 0, NOW + 1000 * DAY_MS)).toBe(false);
    });
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

  // Titles were cut at 50 characters when saved: listed whole now, without a save.
  it('lists a discussion that was not renamed under its whole first message', () => {
    const first = 'Look through the logs of the last three days and tell me what failed and why';
    const conversation: Conversation = {
      id: 'conv_1',
      title: `${first.slice(0, 47)}...`,
      workingDirectory: '/project',
      messages: [{ id: 'm', role: 'user', content: first, timestamp: 1 }],
      createdAt: 1,
      updatedAt: 2,
    };
    expect(summaryOf(conversation).title).toBe(first);
  });

  it('keeps the saved title of a discussion with nothing said yet', () => {
    const conversation: Conversation = {
      id: 'conv_1', title: 'New Conversation', workingDirectory: '/project', messages: [], createdAt: 1, updatedAt: 1,
    };
    expect(summaryOf(conversation).title).toBe('New Conversation');
  });
});
