/**
 * The discussions list as the service serves it, against a real folder:
 * pages, archiving, and writes to one conversation kept in order.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { conversationsDir } = vi.hoisted(() => ({ conversationsDir: { path: '' } }));

vi.mock('../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../utils/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/paths')>();
  return { ...actual, getConversationsPath: () => conversationsDir.path };
});

import { DAY_MS } from '../../../shared/conversation-list';
import type { AutoArchiveDays, Conversation, ConversationSummary } from '../../../shared/types';
import { ConversationService } from '../ConversationService';

import { REAL_DISK_TEST_TIMEOUT_MS } from './support/real-disk';

vi.setConfig({ testTimeout: REAL_DISK_TEST_TIMEOUT_MS });

let root: string;
/** Where Claude Code keeps its sessions, for these tests. */
let claudeDir: string;
let service: ConversationService;

/** A discussion titled, as one not renamed is, by its first message, continuing its own session. */
function conversation(id: string, updatedAt: number, overrides: Partial<Conversation> = {}): Conversation {
  const title = overrides.title ?? `Title ${id}`;
  return {
    id,
    title,
    workingDirectory: '/project',
    messages: [{ id: `${id}-m`, role: 'user', content: title, timestamp: updatedAt }],
    createdAt: updatedAt,
    updatedAt,
    sdkSessionId: `session-${id}`,
    ...overrides,
  };
}

function transcriptOf(sessionId: string): string {
  return path.join(claudeDir, 'projects', '-project', `${sessionId}.jsonl`);
}

/**
 * Store a discussion the way the app does: one update creating it with its
 * messages — its session's transcript written by Claude Code meanwhile.
 */
async function store(c: Conversation): Promise<void> {
  const { messages, ...details } = c;
  if (c.sdkSessionId) {
    fs.mkdirSync(path.dirname(transcriptOf(c.sdkSessionId)), { recursive: true });
    fs.writeFileSync(transcriptOf(c.sdkSessionId), '{}\n');
  }
  await service.update({ ...details, upsert: messages });
}

/** Claude Code cleaned the session up, as it does after its retention period. */
function sessionCleanedUp(sessionId: string): void {
  fs.rmSync(transcriptOf(sessionId));
}

async function page(archived: boolean, autoArchiveDays: AutoArchiveDays = 0, after?: ConversationSummary, limit = 50) {
  return service.listPage({
    archived,
    autoArchiveDays,
    limit,
    ...(after ? { after: { updatedAt: after.updatedAt, id: after.id } } : {}),
  });
}

async function ids(archived: boolean, autoArchiveDays: AutoArchiveDays = 0): Promise<string[]> {
  return (await page(archived, autoArchiveDays, undefined, 1000)).conversations.map((c) => c.id);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-list-'));
  conversationsDir.path = path.join(root, 'conversations');
  claudeDir = path.join(root, 'claude');
  service = new ConversationService(() => claudeDir);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('listPage', () => {
  it('serves the list a page at a time, newest first, each entry once', async () => {
    const now = Date.now();
    // Each save waits on its disk flush: a few discussions, small pages.
    await Promise.all(Array.from({ length: 12 }, (_, i) => store(conversation(`c${String(i).padStart(2, '0')}`, now - i * 1000))));

    const first = await page(false, 0, undefined, 5);
    const second = await page(false, 0, first.conversations.at(-1), 5);
    const third = await page(false, 0, second.conversations.at(-1), 5);

    expect([first, second, third].map((p) => p.conversations.length)).toEqual([5, 5, 2]);
    expect([first, second, third].map((p) => p.hasMore)).toEqual([true, true, false]);
    const all = [first, second, third].flatMap((p) => p.conversations.map((c) => c.id));
    expect(new Set(all).size).toBe(12);
    expect(all[0]).toBe('c00');
    expect(all.at(-1)).toBe('c11');
  });

  it('sees a file changed outside the app on its first page', async () => {
    await store(conversation('a', Date.now()));
    expect(await ids(false)).toEqual(['a']);

    const file = path.join(conversationsDir.path, 'b.json');
    fs.writeFileSync(file, JSON.stringify(conversation('b', Date.now() + 1, { sdkSessionId: undefined })));

    expect(await ids(false)).toEqual(['b', 'a']);
  });

  it('keeps the list in step with renames, updates and deletes', async () => {
    const now = Date.now();
    await store(conversation('a', now));
    await store(conversation('b', now - 1));
    await ids(false);

    await service.rename('b', 'Renamed');
    await service.update({ id: 'b', workingDirectory: '/project', updatedAt: now + 5, upsert: [] });
    await service.delete('a');

    const listed = (await page(false)).conversations;
    expect(listed.map((c) => [c.id, c.title])).toEqual([['b', 'Renamed']]);
  });
});

describe('archiving', () => {
  it('moves a discussion archived by hand to the archived list, and back', async () => {
    const now = Date.now();
    await store(conversation('a', now));
    await store(conversation('b', now - 1));

    await service.setArchived('b', true);
    expect(await ids(false)).toEqual(['a']);
    expect(await ids(true)).toEqual(['b']);
    expect(await service.archivedCount(0)).toBe(1);

    await service.setArchived('b', false);
    expect(await ids(false)).toEqual(['a', 'b']);
    expect(await service.archivedCount(0)).toBe(0);
  });

  it('brings a discussion back by itself when a message comes after it was archived', async () => {
    await store(conversation('a', Date.now() - 1000));
    await service.setArchived('a', true);
    expect(await ids(true)).toEqual(['a']);

    const later = Date.now() + 1000;
    await service.update({
      id: 'a',
      workingDirectory: '/project',
      updatedAt: later,
      upsert: [{ id: 'a-new', role: 'user', content: 'again', timestamp: later }],
    });

    expect(await ids(true)).toEqual([]);
    expect(await ids(false)).toEqual(['a']);
  });

  it('lists a discussion inactive for longer than the setting as archived, until it is brought back', async () => {
    const now = Date.now();
    await store(conversation('recent', now - DAY_MS));
    await store(conversation('old', now - 40 * DAY_MS));

    expect(await ids(false, 30)).toEqual(['recent']);
    expect(await ids(true, 30)).toEqual(['old']);
    expect(await ids(false, 90)).toEqual(['recent', 'old']);
    expect(await service.archivedCount(30)).toBe(1);

    await service.setArchived('old', false);
    expect(await ids(true, 30)).toEqual([]);
  });

  it('keeps the archive flag when a save of the conversation was under way at the same time', async () => {
    const now = Date.now();
    await store(conversation('a', now - 1000));

    // Both at once: the update reads the file, and the archive must not be
    // lost to it writing back what it read before the archive landed.
    await Promise.all([
      service.update({ id: 'a', workingDirectory: '/project', updatedAt: now - 1000, sdkSessionId: 'after', upsert: [] }),
      service.setArchived('a', true),
    ]);

    const stored = JSON.parse(fs.readFileSync(path.join(conversationsDir.path, 'a.json'), 'utf-8')) as Conversation;
    expect(stored.sdkSessionId).toBe('after');
    expect(stored.archivedAt).toBeGreaterThanOrEqual(now - 1000);
    expect(await ids(true)).toEqual(['a']);
  });

  describe('a discussion whose Claude Code session is gone', () => {
    it('is listed as such, from the transcripts on disk — and archived, whatever else', async () => {
      const now = Date.now();
      await store(conversation('kept', now));
      await store(conversation('archived-cleaned', now - 1));
      await store(conversation('active-cleaned', now - 2));
      await store(conversation('active', now - 3));
      // Just started: no session yet, so none lost.
      await store(conversation('new', now - 4, { sdkSessionId: undefined }));
      await service.setArchived('kept', true);
      await service.setArchived('archived-cleaned', true);
      sessionCleanedUp('session-archived-cleaned');
      sessionCleanedUp('session-active-cleaned');

      const gone = async (archived: boolean) =>
        Object.fromEntries((await page(archived)).conversations.map((c) => [c.id, c.sessionGone ?? false]));
      expect(await gone(true)).toEqual({ 'kept': false, 'archived-cleaned': true, 'active-cleaned': true });
      expect(await gone(false)).toEqual({ active: false, new: false });
      expect(await service.archivedCount(0)).toBe(3);
      expect((await service.summary('active-cleaned'))?.sessionGone).toBe(true);
      expect((await service.summary('kept'))?.sessionGone).toBeUndefined();
    });

    describe('with no session id although Claude replied in it — an older version dropped it', () => {
      const reply = (id: string, at: number) =>
        ({ id: `${id}-r`, role: 'assistant' as const, content: 'an answer', timestamp: at });

      it('is archived for good, and opened saying so', async () => {
        const at = Date.now() - 1000;
        const base = conversation('lost', at, { sdkSessionId: undefined });
        await store({ ...base, messages: [...base.messages, reply('lost', at)] });
        // Asked, never answered: no session lost.
        await store(conversation('unanswered', at - 1, { sdkSessionId: undefined }));

        expect(await ids(true)).toEqual(['lost']);
        expect(await ids(false)).toEqual(['unanswered']);
        expect((await service.getWindow('lost', 10))?.conversation.sessionGone).toBe(true);
        expect((await service.getWindow('unanswered', 10))?.conversation.sessionGone).toBeUndefined();
      });

      it('is not brought back from the archive', async () => {
        const at = Date.now() - 1000;
        const base = conversation('lost', at, { sdkSessionId: undefined });
        await store({ ...base, messages: [...base.messages, reply('lost', at)] });
        await service.setArchived('lost', true);

        expect((await service.setArchived('lost', false)).sessionGone).toBe(true);
        expect(await ids(true)).toEqual(['lost']);
      });

      it('is found so in a discussion still in the one-file layout', async () => {
        const at = Date.now();
        const base = conversation('old', at, { sdkSessionId: undefined });
        fs.mkdirSync(conversationsDir.path, { recursive: true });
        fs.writeFileSync(
          path.join(conversationsDir.path, 'old.json'),
          JSON.stringify({ ...base, messages: [...base.messages, reply('old', at)] }),
        );

        expect(await ids(true)).toEqual(['old']);
      });
    });

    it('is archived even when brought back by a message after it was archived', async () => {
      await store(conversation('a', Date.now() - 1000));
      sessionCleanedUp('session-a');
      const later = Date.now() + 1000;
      await service.update({
        id: 'a',
        workingDirectory: '/project',
        updatedAt: later,
        upsert: [{ id: 'a-new', role: 'user', content: 'again', timestamp: later }],
      });

      expect(await ids(true)).toEqual(['a']);
    });

    it('is not brought back from the archive, and the entry says why', async () => {
      await store(conversation('a', Date.now() - 1000));
      await service.setArchived('a', true);
      sessionCleanedUp('session-a');

      const entry = await service.setArchived('a', false);

      expect(entry.sessionGone).toBe(true);
      expect(entry.archivedAt).toBeTypeOf('number');
      expect(await ids(true)).toEqual(['a']);
      const stored = JSON.parse(fs.readFileSync(path.join(conversationsDir.path, 'a.json'), 'utf-8')) as Conversation;
      expect(stored.archivedAt).toBe(entry.archivedAt);
      expect(stored.restoredAt).toBeUndefined();
    });

    it('nor one archived for being inactive', async () => {
      await store(conversation('old', Date.now() - 40 * DAY_MS));
      sessionCleanedUp('session-old');

      expect((await service.setArchived('old', false)).sessionGone).toBe(true);
      expect(await ids(true, 30)).toEqual(['old']);
    });

    it('can still be archived', async () => {
      await store(conversation('a', Date.now() - 1000));
      sessionCleanedUp('session-a');

      expect((await service.setArchived('a', true)).sessionGone).toBe(true);
      expect(await ids(true)).toEqual(['a']);
    });

    it('is opened saying so', async () => {
      await store(conversation('kept', Date.now()));
      await store(conversation('cleaned', Date.now()));
      sessionCleanedUp('session-cleaned');

      expect((await service.getWindow('kept', 10))?.conversation.sessionGone).toBeUndefined();
      expect((await service.getWindow('cleaned', 10))?.conversation.sessionGone).toBe(true);
    });

    it('is never stored as such', async () => {
      await store(conversation('a', Date.now()));
      sessionCleanedUp('session-a');
      await service.setArchived('a', true);
      await service.rename('a', 'Renamed');

      const stored = JSON.parse(fs.readFileSync(path.join(conversationsDir.path, 'a.json'), 'utf-8')) as Conversation;
      expect(stored).not.toHaveProperty('sessionGone');
    });
  });

  it('answers a summary for one discussion, wherever it is in the list', async () => {
    await store(conversation('a', Date.now() - 100 * DAY_MS));
    expect(await service.summary('a')).toMatchObject({ id: 'a', title: 'Title a' });
    expect(await service.summary('missing')).toBeNull();
  });
});

describe('usage-limit waits', () => {
  const HOUR = 60 * 60 * 1000;

  async function stored(id: string): Promise<Conversation> {
    const window_ = await service.getWindow(id, 10);
    expect(window_, `expected ${id} stored`).not.toBeNull();
    return window_!.conversation;
  }

  it('saves a wait with the discussion, without counting it as activity', async () => {
    const at = Date.now() - HOUR;
    await store(conversation('a', at));
    const wait = { resetsAt: at + 2 * HOUR, resumeAt: at + 2 * HOUR + 30_000, limitType: 'five_hour' };

    await service.setUsageLimitWait('a', wait);
    expect((await stored('a')).usageLimitWait).toEqual(wait);
    expect((await stored('a')).updatedAt).toBe(at);
    expect((await service.summary('a'))?.usageLimitWait).toEqual(wait);

    await service.setUsageLimitWait('a', null);
    expect((await stored('a')).usageLimitWait).toBeUndefined();
    expect((await service.summary('a'))?.usageLimitWait).toBeUndefined();
  });

  it('keeps a wait set before the discussion was first saved, and saves it with it', async () => {
    const now = Date.now();
    const wait = { resetsAt: now + HOUR, resumeAt: now + HOUR + 30_000 };
    // The first turn stopped by a limit before the save at its end.
    await service.setUsageLimitWait('new', wait);
    expect(await service.summary('new')).toBeNull();

    await store(conversation('new', now));
    expect((await stored('new')).usageLimitWait).toEqual(wait);
  });

  it('forgets a wait set before the first save when the discussion is deleted meanwhile', async () => {
    const now = Date.now();
    await service.setUsageLimitWait('gone', { resetsAt: now + HOUR, resumeAt: null });
    await service.delete('gone');

    await store(conversation('gone', now));
    expect((await stored('gone')).usageLimitWait).toBeUndefined();
  });

  it('a later save keeps the wait: only setUsageLimitWait changes it', async () => {
    const at = Date.now() - HOUR;
    await store(conversation('a', at));
    const wait = { resetsAt: at + 2 * HOUR, resumeAt: null };
    await service.setUsageLimitWait('a', wait);

    await service.update({ id: 'a', workingDirectory: '/project', updatedAt: at + 1, upsert: [] });
    expect((await stored('a')).usageLimitWait).toEqual(wait);
  });

  describe('taken up at launch', () => {
    const NOW = Date.now();

    async function relaunch(autoArchiveDays: AutoArchiveDays = 7, now = NOW) {
      await service.flushIndex();
      service = new ConversationService(() => claudeDir);
      return service.restoreUsageLimitWaits(autoArchiveDays, now);
    }

    it('keeps a continue still to come as it was, and tells of nothing', async () => {
      await store(conversation('a', NOW - HOUR));
      const wait = { resetsAt: NOW + HOUR, resumeAt: NOW + HOUR + 30_000 };
      await service.setUsageLimitWait('a', wait);

      const restored = await relaunch();
      expect(restored.missed).toEqual([]);
      expect(restored.conversations.map((c) => [c.id, c.usageLimitWait])).toEqual([['a', wait]]);
    });

    it('marks a continue that came due while closed as missed from now, once', async () => {
      await store(conversation('a', NOW - 2 * DAY_MS));
      await service.setUsageLimitWait('a', { resetsAt: NOW - DAY_MS, resumeAt: NOW - DAY_MS + 30_000 });

      const first = await relaunch();
      const missed = { resetsAt: NOW - DAY_MS, resumeAt: null, missedAt: NOW };
      expect(first.missed).toEqual(['a']);
      expect(first.conversations[0]?.usageLimitWait).toEqual(missed);
      expect((await stored('a')).usageLimitWait).toEqual(missed);

      // The next launch finds it missed already: the user is not told again,
      // and the archive delay still counts from the first time.
      const second = await relaunch(7, NOW + DAY_MS);
      expect(second.missed).toEqual([]);
      expect(second.conversations[0]?.usageLimitWait).toEqual(missed);
    });

    it('keeps a missed one out of the archive for the archive delay, though it was inactive for longer', async () => {
      await store(conversation('a', NOW - 30 * DAY_MS));
      await service.setUsageLimitWait('a', { resetsAt: NOW - 29 * DAY_MS, resumeAt: NOW - 29 * DAY_MS + 30_000 });

      const restored = await relaunch(7);
      expect(restored.missed).toEqual(['a']);
      expect(await ids(false, 7)).toEqual(['a']);

      // A week after the user was told: archived, and its wait dropped there.
      const later = await relaunch(7, NOW + 7 * DAY_MS + 1);
      expect(later.conversations).toEqual([]);
      expect((await stored('a')).usageLimitWait).toBeUndefined();
    });

    it('drops the wait of one archived by hand, and tells of nothing', async () => {
      await store(conversation('a', NOW - HOUR));
      await service.setUsageLimitWait('a', { resetsAt: NOW - 1000, resumeAt: NOW - 500 });
      await service.setArchived('a', true);

      const restored = await relaunch();
      expect(restored).toEqual({ conversations: [], missed: [] });
      expect((await stored('a')).usageLimitWait).toBeUndefined();
    });

    it('drops the wait of one whose session is gone, and tells of nothing', async () => {
      await store(conversation('a', NOW - HOUR));
      await service.setUsageLimitWait('a', { resetsAt: NOW - 1000, resumeAt: NOW - 500 });
      sessionCleanedUp('session-a');

      const restored = await relaunch();
      expect(restored).toEqual({ conversations: [], missed: [] });
      expect((await stored('a')).usageLimitWait).toBeUndefined();
    });

    it('drops an offered wait left past the archive delay', async () => {
      await store(conversation('a', NOW - 20 * DAY_MS));
      await service.setUsageLimitWait('a', { resetsAt: NOW - 19 * DAY_MS, resumeAt: null });

      expect(await relaunch(7)).toEqual({ conversations: [], missed: [] });
      // When nothing is archived for being inactive, it stays on offer.
      await service.setUsageLimitWait('a', { resetsAt: NOW - 19 * DAY_MS, resumeAt: null });
      expect((await relaunch(0)).conversations.map((c) => c.id)).toEqual(['a']);
    });
  });
});
