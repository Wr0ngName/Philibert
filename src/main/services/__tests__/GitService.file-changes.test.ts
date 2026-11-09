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

describe('the changes of a file', () => {
  it('are what is not committed yet, staged or not', async () => {
    await commit('a.txt', 'one\n', 'first');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');

    const changes = await service.getFileChanges(repo, path.join(repo, 'a.txt'));

    expect(changes.source).toBe('uncommitted');
    expect(changes.source === 'uncommitted' && changes.patch).toContain('+two');
  });

  it('are the whole file for one git does not track yet', async () => {
    await commit('a.txt', 'one\n', 'first');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'hello\nworld\n');

    const changes = await service.getFileChanges(repo, path.join(repo, 'new.txt'));

    expect(changes).toEqual({
      source: 'uncommitted',
      patch: '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world',
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
    expect(changes.patch).toContain('+three');
    expect(changes.patch).not.toContain('other');
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
    expect(changes.source === 'uncommitted' && changes.patch).toContain('+first line');
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
