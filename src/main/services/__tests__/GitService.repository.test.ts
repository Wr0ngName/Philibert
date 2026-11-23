/**
 * Whether a folder is a git repository, as git itself answers it: what
 * decides whether a discussion starts on Claude Code's system prompt by
 * default (@shared/system-prompt), and what git status and file changes
 * check first. Real git, in temporary folders.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { REAL_DISK_TEST_TIMEOUT_MS } from './support/real-disk';

// Real git, in a temporary repository: given the machine's time (see real-disk).
vi.setConfig({ testTimeout: REAL_DISK_TEST_TIMEOUT_MS });

const execFileAsync = promisify(execFile);

let root: string;
const git = new GitService();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-repository-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a folder is a git repository', () => {
  it('at the top of a working tree, and in a folder within it', async () => {
    const repository = path.join(root, 'repository');
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    await execFileAsync('git', ['init', '--quiet'], { cwd: repository });

    expect(await git.isRepository(repository)).toBe(true);
    expect(await git.isRepository(path.join(repository, 'src'))).toBe(true);
    expect((await git.getStatus(repository)).isGitRepo).toBe(true);
  });
});

describe('a folder is not a git repository', () => {
  it('outside any working tree', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);

    expect(await git.isRepository(plain)).toBe(false);
    expect((await git.getStatus(plain)).isGitRepo).toBe(false);
  });

  it('that does not exist', async () => {
    expect(await git.isRepository(path.join(root, 'gone'))).toBe(false);
  });

  it("that is a repository's own .git folder, where git answers no", async () => {
    const repository = path.join(root, 'repository');
    fs.mkdirSync(repository);
    await execFileAsync('git', ['init', '--quiet'], { cwd: repository });

    expect(await git.isRepository(path.join(repository, '.git'))).toBe(false);
  });
});
