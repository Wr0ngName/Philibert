/**
 * The list's index, against a real folder: a file is parsed when it is new or
 * has changed, and its saved entry is used when it has not.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { Conversation } from '../../../shared/types';
import { ConversationIndex } from '../conversation-index';

let root: string;
let dir: string;
let indexFile: string;

function conversation(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: `Title ${id}`,
    workingDirectory: '/project',
    messages: [{ id: `${id}-m`, role: 'user', content: 'hello', timestamp: 1 }],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function write(c: Conversation): void {
  fs.writeFileSync(path.join(dir, `${c.id}.json`), JSON.stringify(c));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-index-'));
  dir = path.join(root, 'conversations');
  fs.mkdirSync(dir);
  indexFile = path.join(root, 'conversation-index.json');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('ConversationIndex', () => {
  it('lists every conversation file, leaving out what is not one or cannot be read', async () => {
    write(conversation('a'));
    write(conversation('b'));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'text');

    const index = new ConversationIndex(dir, indexFile);
    await index.refresh();

    expect(index.summaries().map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(index.summary('a')).toMatchObject({ title: 'Title a' });
    expect(index.summary('a')).not.toHaveProperty('messages');
  });

  it('uses a saved entry for a file that has not changed, and reads one that has', async () => {
    write(conversation('a'));
    const first = new ConversationIndex(dir, indexFile);
    await first.refresh();
    await first.noteWritten('a.json', conversation('a'));
    await first.flush();

    // The saved entry is altered where only the index has it: a refresh that
    // read the file would not show this title.
    const saved = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
    saved.entries['a.json'].summary.title = 'From the saved index';
    fs.writeFileSync(indexFile, JSON.stringify(saved));

    const second = new ConversationIndex(dir, indexFile);
    await second.refresh();
    expect(second.summary('a')?.title).toBe('From the saved index');

    // Changed since: read again.
    write(conversation('a', { title: 'Changed on disk, longer than before' }));
    await second.refresh();
    expect(second.summary('a')?.title).toBe('Changed on disk, longer than before');
  });

  it('drops a conversation whose file is gone', async () => {
    write(conversation('a'));
    write(conversation('b'));
    const index = new ConversationIndex(dir, indexFile);
    await index.refresh();

    fs.unlinkSync(path.join(dir, 'b.json'));
    await index.refresh();

    expect(index.summaries().map((s) => s.id)).toEqual(['a']);
  });

  it('rebuilds from the files when the saved index is unreadable', async () => {
    write(conversation('a'));
    fs.writeFileSync(indexFile, 'garbage');

    const index = new ConversationIndex(dir, indexFile);
    await index.refresh();

    expect(index.summary('a')?.title).toBe('Title a');
  });

  it('takes a write and a delete into account without a refresh', async () => {
    const index = new ConversationIndex(dir, indexFile);
    await index.refresh();

    const c = conversation('a', { title: 'Written' });
    write(c);
    await index.noteWritten('a.json', c);
    expect(index.summary('a')?.title).toBe('Written');

    index.noteDeleted('a.json');
    expect(index.summary('a')).toBeNull();
  });

  it('runs one refresh at a time, however many ask', async () => {
    write(conversation('a'));
    const index = new ConversationIndex(dir, indexFile);
    const both = [index.refresh(), index.refresh()];
    expect(both[0]).toBe(both[1]);
    await Promise.all(both);
    expect(index.summaries()).toHaveLength(1);
  });
});
