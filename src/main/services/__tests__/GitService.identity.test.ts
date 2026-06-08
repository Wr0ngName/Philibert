/**
 * Tests for GitService identity helpers and the isIdentityError detector.
 *
 * getIdentity / setIdentity run against a real temp git repo (the project
 * already depends on git being installed), so the test exercises the real
 * `git config` semantics — including scope precedence — rather than a mock.
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

import { GitService, isIdentityError } from '../GitService';

const execFileAsync = promisify(execFile);

describe('isIdentityError', () => {
  it('matches the canonical "please tell me who you are" message', () => {
    expect(isIdentityError('*** Please tell me who you are.\nRun ...')).toBe(true);
  });

  it('matches "unable to auto-detect email"', () => {
    expect(isIdentityError('fatal: unable to auto-detect email address (got "user@host)")')).toBe(true);
  });

  it('matches "empty ident name"', () => {
    expect(isIdentityError('fatal: empty ident name (for <user@host>) not allowed')).toBe(true);
  });

  it('matches "no email was given"', () => {
    expect(isIdentityError('fatal: no email was given and auto-detection is disabled')).toBe(true);
  });

  it('matches "no name was given"', () => {
    expect(isIdentityError('fatal: no name was given and auto-detection is disabled')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isIdentityError('PLEASE TELL ME WHO YOU ARE')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isIdentityError('fatal: not a git repository')).toBe(false);
    expect(isIdentityError('error: pathspec did not match any files')).toBe(false);
    expect(isIdentityError('')).toBe(false);
  });
});

describe('GitService identity (real temp repo)', () => {
  let tmpDir: string;
  let service: GitService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-gitsvc-'));
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: tmpDir });
    service = new GitService();
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('getIdentity returns empty strings when nothing is configured locally', async () => {
    // Clear any local-scope values that might leak from a prior test
    await execFileAsync('git', ['config', '--local', '--unset-all', 'user.name'], { cwd: tmpDir }).catch(() => {});
    await execFileAsync('git', ['config', '--local', '--unset-all', 'user.email'], { cwd: tmpDir }).catch(() => {});

    const { name, email } = await service.getIdentity(tmpDir);
    // Global may or may not be set on the test host. The contract is "returns
    // strings, never throws" — so we just assert types here.
    expect(typeof name).toBe('string');
    expect(typeof email).toBe('string');
  });

  it('setIdentity local: writes to .git/config and reads back', async () => {
    await service.setIdentity(tmpDir, 'Alice', 'alice@example.com', 'local');
    const { name, email } = await service.getIdentity(tmpDir);
    expect(name).toBe('Alice');
    expect(email).toBe('alice@example.com');

    // Verify it really went to local config, not global
    const { stdout: localName } = await execFileAsync('git', ['config', '--local', 'user.name'], { cwd: tmpDir });
    expect(localName.trim()).toBe('Alice');
  });

  it('setIdentity trims whitespace', async () => {
    await service.setIdentity(tmpDir, '  Bob  ', '  bob@example.com  ', 'local');
    const { name, email } = await service.getIdentity(tmpDir);
    expect(name).toBe('Bob');
    expect(email).toBe('bob@example.com');
  });

  it('setIdentity rejects empty name or email', async () => {
    await expect(service.setIdentity(tmpDir, '', 'x@y.z', 'local')).rejects.toThrow(/name/i);
    await expect(service.setIdentity(tmpDir, 'X', '   ', 'local')).rejects.toThrow(/email/i);
  });

  it('commit with no identity surfaces a message isIdentityError recognises', async () => {
    // Disable any global identity for this test invocation (without modifying
    // the user's real ~/.gitconfig) by pointing HOME at the empty temp dir
    // and disabling system config.
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hi');
    await execFileAsync('git', ['add', 'file.txt'], { cwd: tmpDir });

    try {
      await execFileAsync('git', ['commit', '-m', 'first'], {
        cwd: tmpDir,
        env: {
          ...process.env,
          HOME: tmpDir,
          XDG_CONFIG_HOME: tmpDir,
          USERPROFILE: tmpDir,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_AUTHOR_NAME: '',
          GIT_AUTHOR_EMAIL: '',
          GIT_COMMITTER_NAME: '',
          GIT_COMMITTER_EMAIL: '',
          EMAIL: '',
        },
      });
      throw new Error('expected commit to fail');
    } catch (err) {
      const msg = (err as Error & { stderr?: string }).stderr || (err as Error).message;
      expect(isIdentityError(msg)).toBe(true);
    }
  });
});
