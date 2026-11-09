/**
 * "Show changes" for a file of the file panel: what is not committed yet,
 * or else the last commit that touched it — against a real temporary
 * repository, as the identity tests do, so the patches are git's own.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../utils/resourcePaths', () => ({
  WindowsPaths: {
    hasBundledGit: () => false,
    getGitExe: () => 'git',
    hasBundledGitBash: () => false,
    buildEnhancedPath: () => process.env.PATH || '',
  },
}));

vi.mock('../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { FileChanges, FileChangeView } from '../../../shared/types';
import { GitService } from '../GitService';

const execFileAsync = promisify(execFile);
const git = (cwd: string, ...args: string[]) => execFileAsync('git', args, { cwd });

let repo: string;
let service: GitService;

async function commit(file: string, content: string, message: string): Promise<void> {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
  await git(repo, 'add', file);
  await git(repo, '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', 'commit', '-q', '-m', message);
}

beforeEach(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-filechanges-'));
  await git(repo, 'init', '-q', '-b', 'main');
  service = new GitService();
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

/** The view of a change, whichever its source. */
function viewOf(changes: FileChanges): FileChangeView {
  if (changes.source !== 'uncommitted' && changes.source !== 'last-commit') throw new Error(`no change: ${changes.source}`);
  return changes.view;
}

/** The patch of a change shown as text. */
function patchOf(changes: FileChanges): string {
  const view = viewOf(changes);
  if (view.kind !== 'text') throw new Error(`not text: ${view.kind}`);
  return view.patch;
}

describe('the changes of a file', () => {
  it('are what is not committed yet, staged or not', async () => {
    await commit('a.txt', 'one\n', 'first');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');

    const changes = await service.getFileChanges(repo, path.join(repo, 'a.txt'));

    expect(changes.source).toBe('uncommitted');
    expect(patchOf(changes)).toContain('+two');
  });

  it('are the whole file for one git does not track yet', async () => {
    await commit('a.txt', 'one\n', 'first');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'hello\nworld\n');

    const changes = await service.getFileChanges(repo, path.join(repo, 'new.txt'));

    expect(changes).toEqual({
      source: 'uncommitted',
      view: { kind: 'text', patch: '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world' },
    });
  });

  it("are its last commit's, with the commit, when nothing is uncommitted", async () => {
    await commit('a.txt', 'one\n', 'first');
    await commit('a.txt', 'one\nthree\n', 'add three');
    await commit('b.txt', 'other\n', 'unrelated later commit');

    const changes = await service.getFileChanges(repo, path.join(repo, 'a.txt'));

    expect(changes.source).toBe('last-commit');
    if (changes.source !== 'last-commit') return;
    expect(changes.commit.subject).toBe('add three');
    expect(changes.commit.author).toBe('Ada');
    expect(changes.commit.shortHash).toMatch(/^[0-9a-f]{7,}$/);
    expect(patchOf(changes)).toContain('+three');
    expect(patchOf(changes)).not.toContain('other');
  });

  it('are none for a file in a repository that no commit touched and that is empty', async () => {
    await commit('a.txt', 'one\n', 'first');
    fs.writeFileSync(path.join(repo, 'empty.txt'), '');

    expect(await service.getFileChanges(repo, path.join(repo, 'empty.txt'))).toEqual({ source: 'none' });
  });

  it('are what is staged, in a repository with no commit yet', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'first line\n');
    await git(repo, 'add', 'a.txt');

    const changes = await service.getFileChanges(repo, path.join(repo, 'a.txt'));

    expect(changes.source).toBe('uncommitted');
    expect(patchOf(changes)).toContain('+first line');
  });

  // Reported: a 200,000-line rewrite gave a 4.6 MB diff, past the buffer
  // git's output was read into: the window showed an error.
  it('are the start of a large change, with its size, rather than an error', async () => {
    const lines = (suffix: string) => Array.from({ length: 200000 }, (_, i) => `${i}${suffix}`).join('\n');
    await commit('big.txt', lines(''), 'first');
    fs.writeFileSync(path.join(repo, 'big.txt'), lines(' changed'));

    const view = viewOf(await service.getFileChanges(repo, path.join(repo, 'big.txt')));

    expect(view.kind).toBe('text');
    if (view.kind !== 'text') return;
    expect(view.truncated).toEqual({ shownLines: 2000, added: 200000, removed: 200000, bytes: null });
    expect(view.patch.split('\n')).toHaveLength(2000);
  });

  it('are the start of a large untracked file, with its size', async () => {
    await commit('a.txt', 'one\n', 'first');
    const content = Array.from({ length: 100000 }, (_, i) => `line ${i}`).join('\n');
    fs.writeFileSync(path.join(repo, 'big-new.txt'), content);

    const view = viewOf(await service.getFileChanges(repo, path.join(repo, 'big-new.txt')));

    expect(view.kind === 'text' && view.truncated).toEqual({ shownLines: 2000, added: null, removed: null, bytes: Buffer.byteLength(content) });
  });

  // Reported: a picture's change read "Binary files a/x.png and b/x.png differ".
  it('are the two versions of a picture', async () => {
    const old = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const now = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9, 9]);
    fs.writeFileSync(path.join(repo, 'pic.png'), old);
    await git(repo, 'add', 'pic.png');
    await git(repo, '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', 'commit', '-q', '-m', 'picture');
    fs.writeFileSync(path.join(repo, 'pic.png'), now);

    expect(viewOf(await service.getFileChanges(repo, path.join(repo, 'pic.png')))).toEqual({
      kind: 'image', mediaType: 'image/png',
      before: old.toString('base64'), after: now.toString('base64'),
      beforeBytes: 8, afterBytes: 9,
    });
  });

  it('are a picture with nothing before it, for the commit that added it', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]);
    fs.writeFileSync(path.join(repo, 'pic.png'), png);
    await git(repo, 'add', 'pic.png');
    await git(repo, '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', 'commit', '-q', '-m', 'add picture');

    const view = viewOf(await service.getFileChanges(repo, path.join(repo, 'pic.png')));

    expect(view).toMatchObject({ kind: 'image', before: null, beforeBytes: null, after: png.toString('base64') });
  });

  it('are the rows of bytes that differ, for other binary files', async () => {
    const old = Buffer.alloc(4096, 0);
    const now = Buffer.from(old);
    now[2050] = 0xff;
    fs.writeFileSync(path.join(repo, 'data.bin'), old);
    await git(repo, 'add', 'data.bin');
    await git(repo, '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', 'commit', '-q', '-m', 'data');
    fs.writeFileSync(path.join(repo, 'data.bin'), now);

    const view = viewOf(await service.getFileChanges(repo, path.join(repo, 'data.bin')));

    expect(view.kind).toBe('binary');
    if (view.kind !== 'binary') return;
    expect(view.beforeBytes).toBe(4096);
    expect(view.afterBytes).toBe(4096);
    expect(view.truncated).toBe(false);
    // Row 128 (offset 2048) differs: rows 127 to 129 shown, the rest counted.
    expect(view.rows.map((row) => ('skipped' in row ? `skip ${row.skipped}` : row.offset))).toEqual(['skip 127', 2032, 2048, 2064, 'skip 126']);
    const changed = view.rows[2] as { before: string[]; after: string[] };
    expect(changed.before[2]).toBe('00');
    expect(changed.after[2]).toBe('ff');
  });

  it('are the bytes of a binary file git does not track yet', async () => {
    await commit('a.txt', 'one\n', 'first');
    fs.writeFileSync(path.join(repo, 'new.bin'), Buffer.from([0, 1, 2]));

    const view = viewOf(await service.getFileChanges(repo, path.join(repo, 'new.bin')));

    expect(view).toEqual({
      kind: 'binary', beforeBytes: null, afterBytes: 3, truncated: false,
      rows: [{ offset: 0, before: null, after: ['00', '01', '02'] }],
    });
  });

  it('say so outside a git repository', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-plain-'));
    try {
      fs.writeFileSync(path.join(plain, 'a.txt'), 'x');
      expect(await service.getFileChanges(plain, path.join(plain, 'a.txt'))).toEqual({ source: 'not-a-repository' });
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
