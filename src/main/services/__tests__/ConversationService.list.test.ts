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

let root: string;
let service: ConversationService;

/** A discussion titled, as one not renamed is, by its first message. */
function conversation(id: string, updatedAt: number, overrides: Partial<Conversation> = {}): Conversation {
  const title = overrides.title ?? `Title ${id}`;
  return {
    id,
    title,
    workingDirectory: '/project',
    messages: [{ id: `${id}-m`, role: 'user', content: title, timestamp: updatedAt }],
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  };
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
  service = new ConversationService();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('listPage', () => {
  it('serves the list a page at a time, newest first, each entry once', async () => {
    const now = Date.now();
    for (let i = 0; i < 120; i++) await service.save(conversation(`c${String(i).padStart(3, '0')}`, now - i * 1000));

    const first = await page(false);
    const second = await page(false, 0, first.conversations.at(-1));
    const third = await page(false, 0, second.conversations.at(-1));

    expect([first, second, third].map((p) => p.conversations.length)).toEqual([50, 50, 20]);
    expect([first, second, third].map((p) => p.hasMore)).toEqual([true, true, false]);
    const all = [first, second, third].flatMap((p) => p.conversations.map((c) => c.id));
    expect(new Set(all).size).toBe(120);
    expect(all[0]).toBe('c000');
    expect(all.at(-1)).toBe('c119');
  });

  it('sees a file changed outside the app on its first page', async () => {
    await service.save(conversation('a', Date.now()));
    expect(await ids(false)).toEqual(['a']);

    const file = path.join(conversationsDir.path, 'b.json');
    fs.writeFileSync(file, JSON.stringify(conversation('b', Date.now() + 1)));

    expect(await ids(false)).toEqual(['b', 'a']);
  });

  it('keeps the list in step with renames, updates and deletes', async () => {
    const now = Date.now();
    await service.save(conversation('a', now));
    await service.save(conversation('b', now - 1));
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
    await service.save(conversation('a', now));
    await service.save(conversation('b', now - 1));

    await service.setArchived('b', true);
    expect(await ids(false)).toEqual(['a']);
    expect(await ids(true)).toEqual(['b']);
    expect(await service.archivedCount(0)).toBe(1);

    await service.setArchived('b', false);
    expect(await ids(false)).toEqual(['a', 'b']);
    expect(await service.archivedCount(0)).toBe(0);
  });

  it('brings a discussion back by itself when a message comes after it was archived', async () => {
    await service.save(conversation('a', Date.now() - 1000));
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
    await service.save(conversation('recent', now - DAY_MS));
    await service.save(conversation('old', now - 40 * DAY_MS));

    expect(await ids(false, 30)).toEqual(['recent']);
    expect(await ids(true, 30)).toEqual(['old']);
    expect(await ids(false, 90)).toEqual(['recent', 'old']);
    expect(await service.archivedCount(30)).toBe(1);

    await service.setArchived('old', false);
    expect(await ids(true, 30)).toEqual([]);
  });

  it('keeps the archive flag when a save of the conversation was under way at the same time', async () => {
    const now = Date.now();
    await service.save(conversation('a', now - 1000));

    // Both at once: the update reads the file, and the archive must not be
    // lost to it writing back what it read before the archive landed.
    await Promise.all([
      service.update({ id: 'a', workingDirectory: '/project', updatedAt: now - 1000, title: 'Retitled', upsert: [] }),
      service.setArchived('a', true),
    ]);

    const stored = JSON.parse(fs.readFileSync(path.join(conversationsDir.path, 'a.json'), 'utf-8')) as Conversation;
    expect(stored.title).toBe('Retitled');
    expect(stored.archivedAt).toBeGreaterThanOrEqual(now - 1000);
    expect(await ids(true)).toEqual(['a']);
  });

  it('answers a summary for one discussion, wherever it is in the list', async () => {
    await service.save(conversation('a', Date.now() - 100 * DAY_MS));
    expect(await service.summary('a')).toMatchObject({ id: 'a', title: 'Title a' });
    expect(await service.summary('missing')).toBeNull();
  });
});
