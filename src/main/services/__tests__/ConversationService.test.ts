/**
 * ConversationService against a real folder: what a discussion's files hold,
 * what a save writes, what survives a write stopped part-way, and reading a
 * long discussion in pieces.
 *
 * Real files rather than a mocked fs: what is under test is exactly what a
 * mock would have to imitate — appends, renames, a file cut short.
 *
 * Reported 2026-11-09: a discussion of 68,144 messages was rewritten whole on
 * every save; the app quit one second into a rewrite and the file was cut at
 * 3.5 MiB, losing all but its first 2,881 messages.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

const { conversationsDir } = vi.hoisted(() => ({ conversationsDir: { path: '' } }));

vi.mock('../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../utils/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/paths')>();
  return { ...actual, getConversationsPath: () => conversationsDir.path };
});

// Compaction at a size a test can reach.
vi.mock('../../constants/app', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../constants/app')>();
  return {
    ...actual,
    MAIN_CONSTANTS: {
      ...actual.MAIN_CONSTANTS,
      CONVERSATION: { ...actual.MAIN_CONSTANTS.CONVERSATION, COMPACT_MIN_REPLACED: 20, RETRY_BASE_DELAY_MS: 1 },
    },
  };
});

import type { ChatMessage, Conversation, ConversationUpdate } from '../../../shared/types';
import realLogger from '../../utils/logger';
import { ConversationService } from '../ConversationService';
import { recordLine } from '../conversation-log';

const logger = realLogger as unknown as Record<'debug' | 'info' | 'warn' | 'error', Mock>;

let root: string;
let service: ConversationService;

const detailsFile = (id: string) => path.join(conversationsDir.path, `${id}.json`);
const messagesFile = (id: string) => path.join(conversationsDir.path, `${id}.messages.jsonl`);
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
const logLines = (id: string) => fs.readFileSync(messagesFile(id), 'utf-8').split('\n').filter(Boolean);

const msg = (id: string, content = `content ${id}`, role: ChatMessage['role'] = 'user'): ChatMessage => ({
  id, role, content, timestamp: 1_700_000_000_000,
});

const base = (id: string): ConversationUpdate => ({
  id, upsert: [], workingDirectory: '/home/user/project', updatedAt: 1_700_000_000_000,
});

/** Create a discussion the way the app does: an update with its first messages. */
async function seed(id: string, messageIds: string[], extra: Partial<ConversationUpdate> = {}): Promise<void> {
  await service.update({ ...base(id), upsert: messageIds.map((m) => msg(m)), createdAt: 1_600_000_000_000, ...extra });
}

async function ids(id: string): Promise<string[]> {
  return ((await service.get(id))?.messages ?? []).map((m) => m.id);
}

/** A discussion in the one-file layout versions up to 0.25.13 wrote. */
function oneFile(id: string, messages: ChatMessage[], overrides: Partial<Conversation> = {}): Conversation {
  return {
    id, title: 'Stored', workingDirectory: '/home/user/project', messages,
    createdAt: 1_600_000_000_000, updatedAt: 1_700_000_000_000, ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-conversations-'));
  conversationsDir.path = path.join(root, 'conversations');
  service = new ConversationService();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the folder', () => {
  it('is created when missing', () => {
    expect(fs.statSync(conversationsDir.path).isDirectory()).toBe(true);
  });
});

describe('what a discussion is stored as', () => {
  it('is its details in one file, and its messages, one per line, in another', async () => {
    await seed('c', ['m1', 'm2'], { sdkSessionId: 'session-1' });

    const details = readJson(detailsFile('c'));
    expect(details).not.toHaveProperty('messages');
    expect(details).toMatchObject({ id: 'c', sdkSessionId: 'session-1', title: 'content m1' });
    expect(logLines('c').map((line) => (JSON.parse(line) as { put: ChatMessage }).put.id)).toEqual(['m1', 'm2']);
  });

  it('reads back as the conversation it was given', async () => {
    await seed('c', ['m1', 'm2'], { sdkSessionId: 'session-1', executionMode: 'sdk' });

    expect(await service.get('c')).toEqual({
      id: 'c',
      title: 'content m1',
      workingDirectory: '/home/user/project',
      createdAt: 1_600_000_000_000,
      updatedAt: 1_700_000_000_000,
      sdkSessionId: 'session-1',
      executionMode: 'sdk',
      messages: [msg('m1'), msg('m2')],
    });
  });

  it('is null for a discussion that does not exist', async () => {
    expect(await service.get('nope')).toBeNull();
  });

  it('fails on an unreadable details file rather than reporting it missing', async () => {
    // `update` builds on what is read: "no such conversation" would make the
    // next save start the discussion over.
    fs.writeFileSync(detailsFile('broken'), '{ not json');

    await expect(service.get('broken')).rejects.toThrow();
  });

  it('leaves an unreadable file out of the list without breaking it', async () => {
    await seed('good', ['m1']);
    fs.writeFileSync(detailsFile('broken'), '{ not json');

    const listed = await service.listPage({ archived: false, autoArchiveDays: 0, limit: 50 });

    expect(listed.conversations.map((c) => c.id)).toEqual(['good']);
    expect(fs.readFileSync(detailsFile('broken'), 'utf-8')).toBe('{ not json');
  });
});

describe('a save', () => {
  it('appends only the messages that changed, not the window it was sent', async () => {
    // The renderer sends the whole window it holds, 1,200 messages in the
    // reported discussion, on every save.
    await seed('c', ['m1', 'm2', 'm3']);

    await service.update({ ...base('c'), upsert: [msg('m1'), msg('m2', 'edited'), msg('m3'), msg('m4')] });

    const added = logLines('c').slice(3).map((line) => (JSON.parse(line) as { put: ChatMessage }).put);
    expect(added).toEqual([msg('m2', 'edited'), msg('m4')]);
    expect(await ids('c')).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('writes no message line when nothing changed, and still its details', async () => {
    await seed('c', ['m1']);
    const before = fs.readFileSync(messagesFile('c'), 'utf-8');

    await service.update({ ...base('c'), upsert: [msg('m1')], sdkSessionId: 'later' });

    expect(fs.readFileSync(messagesFile('c'), 'utf-8')).toBe(before);
    expect(readJson(detailsFile('c')).sdkSessionId).toBe('later');
  });

  it('never rewrites what is already in the messages file', async () => {
    await seed('c', ['m1', 'm2']);
    const before = fs.readFileSync(messagesFile('c'), 'utf-8');

    await service.update({ ...base('c'), upsert: [msg('m3')] });
    await service.update({ ...base('c'), truncateFromId: 'm2' });

    expect(fs.readFileSync(messagesFile('c'), 'utf-8').startsWith(before)).toBe(true);
  });

  it('appends messages it has not seen', async () => {
    await seed('c1', ['m1', 'm2']);

    await service.update({ ...base('c1'), upsert: [msg('m3')] });

    expect(await ids('c1')).toEqual(['m1', 'm2', 'm3']);
  });

  it('replaces a message it already has, where it already is', async () => {
    // Edits legitimately reach stored messages: a streaming flag cleared
    // when a turn ends, a tool result arriving late. Appending a second
    // copy, or moving it to the end, would both corrupt the transcript.
    await seed('c2', ['m1', 'm2', 'm3']);

    await service.update({ ...base('c2'), upsert: [msg('m2', 'edited')] });

    expect(await ids('c2')).toEqual(['m1', 'm2', 'm3']);
    expect((await service.get('c2'))?.messages[1].content).toBe('edited');
  });

  it('creates the conversation when there is none', async () => {
    await service.update({ ...base('c3'), upsert: [msg('m1', 'hello', 'assistant')], title: 'Fresh' });

    expect(await ids('c3')).toEqual(['m1']);
    expect((await service.get('c3'))?.title).toBe('Fresh');
  });

  it('cannot shorten a conversation on its own', async () => {
    // The property everything else rests on.
    await seed('c4', ['m1', 'm2', 'm3', 'm4']);

    await service.update({ ...base('c4'), upsert: [msg('m4')] });

    expect(await ids('c4')).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('truncates from a message when asked to', async () => {
    // What a rewind does: that turn and the ones after it really are gone.
    await seed('c5', ['m1', 'm2', 'm3', 'm4']);

    await service.update({ ...base('c5'), truncateFromId: 'm3' });

    expect(await ids('c5')).toEqual(['m1', 'm2']);
  });

  it('truncates and then appends in one write', async () => {
    // The rewind writes the turns that follow it in the same save.
    await seed('c6', ['m1', 'm2', 'm3']);

    await service.update({ ...base('c6'), truncateFromId: 'm2', upsert: [msg('m9')] });

    expect(await ids('c6')).toEqual(['m1', 'm9']);
  });

  it('keeps the history when the truncation anchor is gone', async () => {
    // "From" cannot be known without the anchor. Dropping nothing is the
    // recoverable mistake; dropping everything is not.
    await seed('c7', ['m1', 'm2', 'm3']);

    await service.update({ ...base('c7'), truncateFromId: 'does-not-exist' });

    expect(await ids('c7')).toEqual(['m1', 'm2', 'm3']);
  });

  it('clears every message when the first one is the anchor', async () => {
    await seed('c8', ['m1', 'm2']);

    await service.update({ ...base('c8'), truncateFromId: 'm1' });

    expect(await ids('c8')).toEqual([]);
  });

  it('keeps details it was not given', async () => {
    await seed('c9', ['m1'], { sdkSessionId: 'session-1', title: 'Kept', customTitle: true });

    await service.update({ ...base('c9'), upsert: [msg('m2')] });

    const stored = await service.get('c9');
    expect(stored?.sdkSessionId).toBe('session-1');
    expect(stored?.title).toBe('Kept');
  });

  it('applies the details it was given', async () => {
    await seed('c10', ['m1']);

    await service.update({ ...base('c10'), title: 'Renamed', customTitle: true, sdkSessionId: 'session-2' });

    const stored = await service.get('c10');
    expect(stored?.title).toBe('Renamed');
    expect(stored?.customTitle).toBe(true);
    expect(stored?.sdkSessionId).toBe('session-2');
  });

  it('keeps the original createdAt', async () => {
    await seed('c11', ['m1']);

    await service.update({ ...base('c11'), upsert: [msg('m2')], createdAt: 999 });

    expect((await service.get('c11'))?.createdAt).toBe(1_600_000_000_000);
  });

  it('is idempotent, so a retried write cannot duplicate anything', async () => {
    await seed('c12', ['m1']);

    await service.update({ ...base('c12'), upsert: [msg('m2')] });
    await service.update({ ...base('c12'), upsert: [msg('m2')] });

    expect(await ids('c12')).toEqual(['m1', 'm2']);
  });

  it('starts a discussion afresh over the messages a stopped deletion left behind', async () => {
    await seed('c', ['old1', 'old2']);
    const leftover = fs.readFileSync(messagesFile('c'), 'utf-8');
    await service.delete('c');
    fs.writeFileSync(messagesFile('c'), leftover);

    await service.update({ ...base('c'), upsert: [msg('new1')] });

    expect(await ids('c')).toEqual(['new1']);
  });

  it('retries a write the disk refused for a moment, and lands it once', async () => {
    await seed('c', ['m1']);
    const open = fs.promises.open.bind(fs.promises);
    let refused = 0;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags) => {
      if (refused < 2 && String(file).endsWith('.messages.jsonl')) {
        refused += 1;
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return open(file, flags);
    });

    await service.update({ ...base('c'), upsert: [msg('m2')] });

    expect(refused).toBe(2);
    expect(await ids('c')).toEqual(['m1', 'm2']);
  });

  it('fails when the disk keeps refusing, and the next save still lands everything', async () => {
    await seed('c', ['m1']);
    const spy = vi.spyOn(fs.promises, 'open').mockRejectedValue(
      Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }),
    );

    await expect(service.update({ ...base('c'), upsert: [msg('m2')] })).rejects.toThrow('EBUSY');
    spy.mockRestore();
    await service.update({ ...base('c'), upsert: [msg('m2'), msg('m3')] });

    expect(await ids('c')).toEqual(['m1', 'm2', 'm3']);
  });
});

describe('titles', () => {
  it('are the first user message', async () => {
    await service.update({ ...base('t'), upsert: [msg('a', 'answer first', 'assistant'), msg('q', 'How do I fix this bug?')] });

    expect(readJson(detailsFile('t')).title).toBe('How do I fix this bug?');
  });

  it('keep a long first message whole: the list cuts it at its own width', async () => {
    const long = 'This is a very long message that the list used to cut at fifty characters, whatever its width';
    await service.update({ ...base('t'), upsert: [msg('q', long)] });

    expect(readJson(detailsFile('t')).title).toBe(long);
  });

  it('are the one given while no user message gives one', async () => {
    await service.update({ ...base('t'), upsert: [msg('a', 'hello', 'assistant')], title: 'New Conversation' });

    expect(readJson(detailsFile('t')).title).toBe('New Conversation');
  });

  it('stay the one chosen once renamed', async () => {
    await seed('t', ['m1']);
    await service.rename('t', '  Chosen  ');

    await service.update({ ...base('t'), upsert: [msg('m2')] });

    expect(readJson(detailsFile('t'))).toMatchObject({ title: 'Chosen', customTitle: true });
  });

  it('follow an edit of the first message', async () => {
    await service.update({ ...base('t'), upsert: [msg('q', 'first wording')] });

    await service.update({ ...base('t'), upsert: [msg('q', 'second wording')] });

    expect(readJson(detailsFile('t')).title).toBe('second wording');
  });
});

describe('a write stopped part-way', () => {
  it('leaves every message before it readable', async () => {
    await seed('c', ['m1', 'm2']);
    // What a process ended mid-append leaves: the start of a line.
    fs.appendFileSync(messagesFile('c'), '\n{"put":{"id":"m3","role":"user","cont');

    const service2 = new ConversationService();

    expect((await service2.get('c'))?.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(logger.warn).toHaveBeenCalledWith(
      'Skipped lines of a messages file that a stopped write left unfinished', { id: 'c', damaged: 1 },
    );
  });

  it('does not take the next save down with it', async () => {
    await seed('c', ['m1']);
    fs.appendFileSync(messagesFile('c'), '\n{"put":{"id":"m2","role":"us');
    const service2 = new ConversationService();

    await service2.update({ ...base('c'), upsert: [msg('m2'), msg('m3')] });

    expect((await new ConversationService().get('c'))?.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('leaves the details as they were when it stopped before its rename', async () => {
    await seed('c', ['m1'], { sdkSessionId: 'before' });
    // A replace stopped part-way: its temporary file, never renamed.
    fs.writeFileSync(`${detailsFile('c')}.tmp`, '{"id":"c","sdkSess');

    expect((await service.get('c'))?.sdkSessionId).toBe('before');
  });

  it('leaves temporary files that the next start removes', async () => {
    await seed('c', ['m1']);
    fs.writeFileSync(`${detailsFile('c')}.tmp`, 'partial');
    fs.writeFileSync(`${messagesFile('c')}.tmp`, 'partial');

    await new ConversationService().upgradeStorage();

    expect(fs.readdirSync(conversationsDir.path).sort()).toEqual(['c.json', 'c.messages.jsonl']);
  });
});

describe('compaction', () => {
  it('rewrites the messages file to its live messages once replaced lines outnumber them', async () => {
    await seed('c', ['m1', 'm2']);
    // A streaming answer: the same message saved again and again.
    for (let i = 0; i < 25; i++) await service.update({ ...base('c'), upsert: [msg('m2', `streamed ${i}`)] });

    expect(logLines('c').length).toBeLessThan(25);
    expect((await new ConversationService().get('c'))?.messages).toEqual([msg('m1'), msg('m2', 'streamed 24')]);
  });

  it('keeps saving after compacting, without writing what did not change', async () => {
    await seed('c', ['m1', 'm2']);
    for (let i = 0; i < 25; i++) await service.update({ ...base('c'), upsert: [msg('m2', `streamed ${i}`)] });
    const lines = logLines('c').length;

    await service.update({ ...base('c'), upsert: [msg('m1'), msg('m2', 'streamed 24'), msg('m3')] });

    expect(logLines('c').length).toBe(lines + 1);
    expect(await ids('c')).toEqual(['m1', 'm2', 'm3']);
  });
});

describe('discussions stored in one file, as up to 0.25.13', () => {
  it('are converted at startup, messages and details intact', async () => {
    const stored = oneFile('old', [msg('m1', 'the first question'), msg('m2', 'an answer', 'assistant')], {
      sdkSessionId: 'session-old', title: 'the first question',
    });
    fs.writeFileSync(detailsFile('old'), JSON.stringify(stored));

    await service.upgradeStorage();

    expect(readJson(detailsFile('old'))).not.toHaveProperty('messages');
    expect(await service.get('old')).toEqual(stored);
  });

  it('are titled as the list showed them, not as an older version cut them', async () => {
    const first = 'A first message longer than the fifty characters titles were cut at';
    fs.writeFileSync(detailsFile('old'), JSON.stringify(oneFile('old', [msg('m1', first)], { title: first.slice(0, 50) })));

    await service.upgradeStorage();

    expect(readJson(detailsFile('old')).title).toBe(first);
  });

  it('lose a repeated message id, keeping the first', async () => {
    fs.writeFileSync(detailsFile('old'), JSON.stringify(oneFile('old', [msg('m1', 'first'), msg('m2'), msg('m1', 'repeat')])));

    await service.upgradeStorage();

    expect((await service.get('old'))?.messages.map((m) => [m.id, m.content])).toEqual([['m1', 'first'], ['m2', 'content m2']]);
  });

  it('are converted again from the one file when a conversion stopped between its two writes', async () => {
    // The messages file is written first; stopped there, the one file is
    // still whole, and is what the next start converts from.
    const stored = oneFile('old', [msg('m1'), msg('m2')]);
    fs.writeFileSync(detailsFile('old'), JSON.stringify(stored));
    fs.writeFileSync(messagesFile('old'), '{"put":{"id":"m1","role":"user","content":"content m1","timestamp":1}}\n{"put":{"id":"m2"');

    await service.upgradeStorage();

    expect((await service.get('old'))?.messages).toEqual(stored.messages);
  });

  it('say which one is being converted, so startup can show why it waits', async () => {
    // Asked for: a long conversion must not look like an app that hangs.
    await seed('new', ['m1']);
    fs.writeFileSync(detailsFile('old'), JSON.stringify(oneFile('old', [msg('m1')])));
    const progress: unknown[] = [];

    await service.upgradeStorage((p) => progress.push(p));

    // One of the two needed converting; the other is in the current layout.
    // Counted in the folder's own order, as the conversion goes through it.
    const order = fs.readdirSync(conversationsDir.path).filter((n) => n.endsWith('.json'));
    expect(progress).toEqual([{ at: order.indexOf('old.json') + 1, of: 2 }]);
  });

  it('say nothing at a start with nothing to convert', async () => {
    await seed('new', ['m1']);
    const progress: unknown[] = [];

    await service.upgradeStorage((p) => progress.push(p));

    expect(progress).toEqual([]);
  });

  it('are left exactly as they are when they cannot be read', async () => {
    // The 2026-11-09 file: cut mid-string. Kept for what can be recovered.
    const cut = '{"id":"cut","title":"x","messages":[{"id":"m1","role":"user","content":"unfini';
    fs.writeFileSync(detailsFile('cut'), cut);

    await service.upgradeStorage();

    expect(fs.readFileSync(detailsFile('cut'), 'utf-8')).toBe(cut);
    expect(fs.existsSync(messagesFile('cut'))).toBe(false);
  });

  it('are converted when opened, if copied into the folder while the app runs', async () => {
    await service.upgradeStorage();
    const stored = oneFile('copied', [msg('m1'), msg('m2')]);
    fs.writeFileSync(detailsFile('copied'), JSON.stringify(stored));

    expect((await service.get('copied'))?.messages).toEqual(stored.messages);
    expect(readJson(detailsFile('copied'))).not.toHaveProperty('messages');
  });

  it('keep their messages when the first thing to reach them is a save', async () => {
    // A save builds on what is stored; one that read only the details file
    // would have started this history over.
    const stored = oneFile('copied', [msg('m1'), msg('m2')]);
    fs.writeFileSync(detailsFile('copied'), JSON.stringify(stored));

    await service.update({ ...base('copied'), upsert: [msg('m3')] });

    expect(await ids('copied')).toEqual(['m1', 'm2', 'm3']);
  });
});

describe('deleting', () => {
  it('removes both files', async () => {
    await seed('c', ['m1']);

    await service.delete('c');

    expect(fs.readdirSync(conversationsDir.path)).toEqual([]);
    expect(await service.get('c')).toBeNull();
  });

  it('does not fail for a discussion that is not there', async () => {
    await expect(service.delete('nope')).resolves.toBeUndefined();
  });

  it('leaves messages it could not remove to the next start', async () => {
    await seed('c', ['m1']);
    fs.unlinkSync(detailsFile('c'));

    await new ConversationService().upgradeStorage();

    expect(fs.readdirSync(conversationsDir.path)).toEqual([]);
  });
});

describe('details changed on their own', () => {
  it('rename without touching the messages', async () => {
    await seed('c', ['m1', 'm2']);
    const messages = fs.readFileSync(messagesFile('c'), 'utf-8');

    await service.rename('c', 'Renamed');

    expect(fs.readFileSync(messagesFile('c'), 'utf-8')).toBe(messages);
    expect((await service.summary('c'))?.title).toBe('Renamed');
  });

  it('archive without touching the messages', async () => {
    await seed('c', ['m1']);
    const messages = fs.readFileSync(messagesFile('c'), 'utf-8');

    const summary = await service.setArchived('c', true);

    expect(fs.readFileSync(messagesFile('c'), 'utf-8')).toBe(messages);
    expect(summary.archivedAt).toBeGreaterThan(0);
  });

  it('fail for a discussion that is not there', async () => {
    await expect(service.rename('nope', 'x')).rejects.toThrow('Conversation not found: nope');
  });
});

describe('reading a conversation as a window', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `m${i}`, role: 'user' as const, content: `message ${i}`, timestamp: 1000 + i,
  }));

  beforeEach(async () => {
    await service.update({ ...base('long'), title: 'Long', upsert: many(1000) });
  });

  it('returns the most recent messages and counts the rest', async () => {
    const window = await service.getWindow('long', 100);

    expect(window?.conversation.messages).toHaveLength(100);
    expect(window?.conversation.messages[0].id).toBe('m900');
    expect(window?.olderCount).toBe(900);
  });

  it('returns everything when the limit exceeds the conversation', async () => {
    const window = await service.getWindow('long', 5000);

    expect(window?.conversation.messages).toHaveLength(1000);
    expect(window?.olderCount).toBe(0);
  });

  it('is null for a conversation that does not exist', async () => {
    expect(await service.getWindow('nope', 10)).toBeNull();
  });

  it('returns the page before a given message', async () => {
    const page = await service.getOlder('long', 'm900', 100);

    expect(page?.messages).toHaveLength(100);
    expect(page?.messages[0].id).toBe('m800');
    expect(page?.messages.at(-1)?.id).toBe('m899');
    expect(page?.olderCount).toBe(800);
  });

  it('stops at the beginning rather than wrapping', async () => {
    const page = await service.getOlder('long', 'm10', 100);

    expect(page?.messages.map((m) => m.id)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i}`));
    expect(page?.olderCount).toBe(0);
  });

  it('answers emptily for an id it does not hold', async () => {
    // Keyed by id rather than by index precisely so a conversation that
    // grew in between cannot shift a page; an unknown id is then the
    // honest "nothing to give you".
    const page = await service.getOlder('long', 'not-a-message', 100);

    expect(page?.messages).toEqual([]);
    expect(page?.olderCount).toBe(0);
  });

  it('returns the page after a given message', async () => {
    const page = await service.getNewer('long', 'm899', 50);

    expect(page?.messages[0].id).toBe('m900');
    expect(page?.messages).toHaveLength(50);
    expect(page?.newerCount).toBe(50);
  });

  // A turn the renderer holds in memory apart from its window may be
  // stored in part, and its copy in memory is ahead of the stored one. A
  // read running into it would hand back a stale copy and count it twice.
  it('stops a page at the start of a turn held in memory', async () => {
    const page = await service.getNewer('long', 'm899', 500, 'm950');

    expect(page?.messages.map((m) => m.id)).toEqual(Array.from({ length: 50 }, (_, i) => `m${900 + i}`));
    expect(page?.newerCount).toBe(0);
  });

  it('counts only what lies before a held turn', async () => {
    const page = await service.getNewer('long', 'm899', 10, 'm950');

    expect(page?.messages).toHaveLength(10);
    expect(page?.newerCount).toBe(40);
  });

  it('ignores a held turn that is not stored yet', async () => {
    const page = await service.getNewer('long', 'm989', 500, 'not-stored-yet');

    expect(page?.messages).toHaveLength(10);
    expect(page?.newerCount).toBe(0);
  });

  it('returns nothing past a held turn, even asked from inside it', async () => {
    const page = await service.getNewer('long', 'm960', 10, 'm950');

    expect(page?.messages).toEqual([]);
    expect(page?.newerCount).toBe(0);
  });

  it('returns the stretch around a message, counted either side', async () => {
    const around = await service.getAround('long', 'm500', 250, 250);

    expect(around?.messages[0].id).toBe('m250');
    expect(around?.messages.at(-1)?.id).toBe('m750');
    expect(around?.messages).toHaveLength(501);
    expect(around?.olderCount).toBe(250);
    expect(around?.newerCount).toBe(249);
  });

  it('clamps the stretch at both ends of the conversation', async () => {
    const first = await service.getAround('long', 'm3', 250, 250);
    expect(first?.olderCount).toBe(0);
    expect(first?.messages[0].id).toBe('m0');

    const last = await service.getAround('long', 'm998', 250, 250);
    expect(last?.newerCount).toBe(0);
    expect(last?.messages.at(-1)?.id).toBe('m999');
  });

  it('stops the stretch at the start of a held turn', async () => {
    const around = await service.getAround('long', 'm900', 250, 250, 'm950');

    expect(around?.messages.at(-1)?.id).toBe('m949');
    expect(around?.newerCount).toBe(0);
  });

  it('has no stretch for a message inside a held turn, or one not stored', async () => {
    expect(await service.getAround('long', 'm960', 250, 250, 'm950')).toBeNull();
    expect(await service.getAround('long', 'nope', 250, 250)).toBeNull();
    expect(await service.getAround('nope', 'm1', 250, 250)).toBeNull();
  });
});

describe('a page of a long discussion', () => {
  const many = (n: number, from = 0) => Array.from({ length: n }, (_, i) => msg(`m${from + i}`, `message ${from + i}`));
  const pageIds = (page: { messages: ChatMessage[] } | null) => (page?.messages ?? []).map((m) => m.id);

  /** Whether the messages file was read whole while `run` ran. */
  async function readWhole(id: string, run: () => Promise<unknown>): Promise<boolean> {
    const spy = vi.spyOn(fs.promises, 'readFile');
    try {
      await run();
      return spy.mock.calls.some(([file]) => String(file) === messagesFile(id));
    } finally {
      spy.mockRestore();
    }
  }

  beforeEach(async () => {
    await service.update({ ...base('long'), upsert: many(300) });
  });

  it('reads only its own lines, not the whole messages file', async () => {
    // Reported: opening and scrolling a 68,000-message discussion parsed the
    // whole file for every page of 500.
    expect(await readWhole('long', () => service.getWindow('long', 50))).toBe(false);
    expect(await readWhole('long', () => service.getOlder('long', 'm250', 50))).toBe(false);
    expect(await readWhole('long', () => service.getNewer('long', 'm100', 50))).toBe(false);
    expect(await readWhole('long', () => service.getAround('long', 'm150', 10, 10))).toBe(false);
  });

  it('reads the whole file once, the first time in a process, then only pages', async () => {
    const fresh = new ConversationService();

    expect(await readWhole('long', () => fresh.getWindow('long', 50))).toBe(true);
    expect(await readWhole('long', () => fresh.getOlder('long', 'm250', 50))).toBe(false);
  });

  it('holds the latest version of each message, after changes, appends and a rewind', async () => {
    await service.update({ ...base('long'), upsert: [msg('m10', 'edited ten'), ...many(5, 300)] });
    await service.update({ ...base('long'), truncateFromId: 'm302' });

    const window = await service.getWindow('long', 5);
    const older = await service.getOlder('long', 'm12', 3);

    expect(pageIds(window?.conversation ?? null)).toEqual(['m297', 'm298', 'm299', 'm300', 'm301']);
    expect(older?.messages.map((m) => m.content)).toEqual(['message 9', 'edited ten', 'message 11']);
    expect(older?.olderCount).toBe(9);
  });

  it('holds the right messages after the file was compacted', async () => {
    for (let i = 0; i < 25; i++) await service.update({ ...base('long'), upsert: [msg('m5', `streamed ${i}`)] });

    const page = await service.getOlder('long', 'm7', 3);

    expect(page?.messages.map((m) => m.content)).toEqual(['message 4', 'streamed 24', 'message 6']);
  });

  it('reads the whole file again when it was compacted while the page was being read', async () => {
    // Few messages, so a few replaced lines are enough to compact.
    await service.update({ ...base('short'), upsert: many(30) });
    await service.getWindow('short', 10);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const open = fs.promises.open.bind(fs.promises);
    let holding = true;
    // The page's locations are taken, then the file is compacted before the
    // page opens it: its lines are no longer where they were.
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags) => {
      if (holding && flags === 'r') {
        holding = false;
        await held;
      }
      return open(file, flags);
    });

    const reading = service.getOlder('short', 'm20', 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (let i = 0; i < 35; i++) await service.update({ ...base('short'), upsert: [msg('m25', `streamed ${i}`)] });
    expect(logger.info).toHaveBeenCalledWith('Compacted a conversation messages file', expect.objectContaining({ id: 'short' }));
    release();

    expect(pageIds(await reading)).toEqual(['m17', 'm18', 'm19']);
    expect(logger.info).toHaveBeenCalledWith(
      'Reading a page of a conversation from its whole messages file', { id: 'short', reason: 'the file was replaced' },
    );
  });

  it('reads the whole file again when a line does not hold the message it should', async () => {
    // The file changed behind the app's back: its lines are no longer where
    // they were. A page must not show one message in another's place.
    await service.getWindow('long', 10);
    // Two lines of the same length swapped: each location now holds a
    // whole, readable line — of the other message.
    const text = fs.readFileSync(messagesFile('long'), 'utf-8');
    const line = (id: string) => recordLine({ put: msg(id, `message ${id.slice(1)}`) });
    expect(line('m17')).toHaveLength(line('m18').length);
    fs.writeFileSync(messagesFile('long'), text.replace(line('m17'), '@@').replace(line('m18'), line('m17')).replace('@@', line('m18')));

    const page = await service.getOlder('long', 'm20', 3);

    expect(page?.messages.map((m) => [m.id, m.content])).toEqual([['m17', 'message 17'], ['m18', 'message 18'], ['m19', 'message 19']]);
    expect(logger.info).toHaveBeenCalledWith(
      'Reading a page of a conversation from its whole messages file', { id: 'long', reason: 'a line did not hold its message' },
    );
  });
});

describe('reads and writes at once', () => {
  it('never shows a new discussion without the messages it was saved with', async () => {
    // The details file is what makes a discussion exist: written last, so a
    // read during the first save finds no discussion rather than an empty one.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags) => {
      if (String(file).endsWith('.messages.jsonl')) await held;
      return open(file, flags);
    });
    const saving = service.update({ ...base('new'), upsert: [msg('m1')] });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const during = await service.get('new');
    release();
    await saving;

    expect(during).toBeNull();
    expect(await ids('new')).toEqual(['m1']);
  });

  it('a rewind after a read that overlapped a save still finds its turn', async () => {
    // A read does not wait for writes. One that read the file before a save
    // appended to it, and finished after, holds the file as it was: that
    // must not become what the next write builds on, or a rewind would not
    // find the turn it cuts from, and keep it.
    await seed('c', ['m1']);
    let finishRead: () => void = () => {};
    const readHeld = new Promise<void>((resolve) => { finishRead = resolve; });
    const readFile = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'readFile').mockImplementation(async (file, options) => {
      const content = await readFile(file, options);
      if (String(file).endsWith('.messages.jsonl')) await readHeld;
      return content;
    });

    const reading = service.get('c');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await service.update({ ...base('c'), upsert: [msg('m2'), msg('m3')] });
    finishRead();
    expect((await reading)?.messages.map((m) => m.id)).toEqual(['m1']);
    vi.restoreAllMocks();

    await service.update({ ...base('c'), truncateFromId: 'm2' });

    expect(await ids('c')).toEqual(['m1']);
  });
});

describe('settleWrites', () => {
  it('waits for the writes under way', async () => {
    await seed('c', ['m1']);
    let landed = false;
    void service.update({ ...base('c'), upsert: [msg('m2')] }).then(() => { landed = true; });

    expect(await service.settleWrites(10_000)).toBe(true);
    expect(landed).toBe(true);
  });

  it('stops waiting at its bound, and says so', async () => {
    await seed('c', ['m1']);
    // The disk stops answering at the save's first open, until released.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags) => {
      await held;
      return open(file, flags);
    });
    const write = service.update({ ...base('c'), upsert: [msg('m2')] });

    expect(await service.settleWrites(20)).toBe(false);
    release();
    await write;
  });
});

describe('search', () => {
  it('finds a word in the messages of every discussion, newest first', async () => {
    await service.update({ ...base('a'), upsert: [{ ...msg('a1', 'the needle here'), timestamp: 1 }] });
    await service.update({ ...base('b'), upsert: [{ ...msg('b1', 'another Needle'), timestamp: 2 }, msg('b2', 'nothing')] });

    const found = await service.search('needle', 'all', null);

    expect(found.map((r) => [r.conversationId, r.messageId])).toEqual([['b', 'b1'], ['a', 'a1']]);
  });

  it('searches only the open discussion when asked to', async () => {
    await service.update({ ...base('a'), upsert: [msg('a1', 'needle')] });
    await service.update({ ...base('b'), upsert: [msg('b1', 'needle')] });

    const found = await service.search('needle', 'current', 'b');

    expect(found.map((r) => r.conversationId)).toEqual(['b']);
  });
});

describe('recoverSessionData()', () => {
  const SESSION_ID = 'abc123-session';
  const REAL_CWD = 'C:\\Claude\\Claude Femmexpat\\actual-subdir';
  const STALE_CWD = 'C:\\Claude\\Claude Femmexpat';
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    home = path.join(root, 'home');
    process.env.HOME = home;
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = savedHome;
  });

  function sessionFile(dirName: string, cwd: string): void {
    const dir = path.join(home, '.claude', 'projects', dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SESSION_ID}.jsonl`), `${JSON.stringify({ type: 'system', cwd })}\n`);
  }

  it('finds the session file by its id, whatever its folder, and takes its folder', async () => {
    await seed('rec', ['m1'], { workingDirectory: STALE_CWD, sdkSessionId: SESSION_ID });
    sessionFile('whatever-dir-name-doesnt-matter', REAL_CWD);
    const messages = fs.readFileSync(messagesFile('rec'), 'utf-8');

    await service.recoverSessionData();

    expect(readJson(detailsFile('rec')).workingDirectory).toBe(REAL_CWD);
    expect(fs.readFileSync(messagesFile('rec'), 'utf-8')).toBe(messages);
  });

  it('leaves a discussion whose folder already matches', async () => {
    await seed('ok', ['m1'], { workingDirectory: REAL_CWD, sdkSessionId: SESSION_ID });
    sessionFile('dir', REAL_CWD);
    const before = fs.readFileSync(detailsFile('ok'), 'utf-8');

    await service.recoverSessionData();

    expect(fs.readFileSync(detailsFile('ok'), 'utf-8')).toBe(before);
  });

  it('leaves a discussion whose session file is gone', async () => {
    await seed('gone', ['m1'], { workingDirectory: STALE_CWD, sdkSessionId: SESSION_ID });
    const before = fs.readFileSync(detailsFile('gone'), 'utf-8');

    await service.recoverSessionData();

    expect(fs.readFileSync(detailsFile('gone'), 'utf-8')).toBe(before);
  });

  it('skips a discussion with no session', async () => {
    await seed('none', ['m1'], { workingDirectory: STALE_CWD });
    sessionFile('dir', REAL_CWD);
    const before = fs.readFileSync(detailsFile('none'), 'utf-8');

    await service.recoverSessionData();

    expect(fs.readFileSync(detailsFile('none'), 'utf-8')).toBe(before);
  });

  it('does nothing when there is no ~/.claude/projects', async () => {
    fs.rmSync(path.join(home, '.claude'), { recursive: true });
    await seed('c', ['m1'], { workingDirectory: STALE_CWD, sdkSessionId: SESSION_ID });

    await service.recoverSessionData();

    expect(readJson(detailsFile('c')).workingDirectory).toBe(STALE_CWD);
  });
});

describe('create()', () => {
  it('makes an empty discussion in a folder, with a unique id, not yet stored', () => {
    const a = service.create('/home/user/project');
    const b = service.create('/home/user/project');

    expect(a).toMatchObject({ title: '', workingDirectory: '/home/user/project', messages: [] });
    expect(a.id).not.toBe(b.id);
    expect(fs.readdirSync(conversationsDir.path)).toEqual([]);
  });
});
