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
