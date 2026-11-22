/**
 * A release's notes (scripts/release-notes.mjs): RELEASE_NOTES.md's section
 * shown to users, the changes git-cliff lists on the release page, and the
 * update feed's releaseNotes, read back by electron-updater's own parser.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parseUpdateInfo } from 'electron-updater/out/providers/Provider';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  baseVersion,
  feedNotes,
  previousTag,
  releasePage,
  whatsNew,
} from '../../../scripts/release-notes.mjs';
import { REAL_DISK_TEST_TIMEOUT_MS } from '../../main/services/__tests__/support/real-disk';

const SCRIPT = resolve(__dirname, '../../../scripts/release-notes.mjs');

const NOTES = `# What's new in Philibert

Intro.

## 1.1.0

- **New**: something users notice.
- Fixed: "quotes", colons: and # hashes.

  A paragraph after a blank line.
`;

describe('baseVersion', () => {
  it('is the version a tag leads to', () => {
    expect(baseVersion('v1.1.0')).toBe('1.1.0');
    expect(baseVersion('v1.1.0-rc.3')).toBe('1.1.0');
  });

  it('refuses what is not a release tag', () => {
    expect(() => baseVersion('1.1.0')).toThrow('Not a release tag');
    expect(() => baseVersion('v1.1.0-beta.1')).toThrow('Not a release tag');
  });
});

describe('whatsNew', () => {
  it("is the version's section, up to the next one", () => {
    expect(whatsNew(NOTES, '1.1.0')).toBe(
      '- **New**: something users notice.\n- Fixed: "quotes", colons: and # hashes.\n\n  A paragraph after a blank line.',
    );
    expect(whatsNew(`${NOTES}\n## 1.0.0\n\n- First release.\n`, '1.1.0')).toBe(whatsNew(NOTES, '1.1.0'));
  });

  it("is null for a version with no section, or an empty one: never the notes of the release before", () => {
    expect(whatsNew(NOTES, '1.2.0')).toBeNull();
    expect(whatsNew('## 1.2.0\n\n## 1.1.0\n- x\n', '1.2.0')).toBeNull();
  });

  it('does not take a longer version for a shorter one', () => {
    expect(whatsNew('## 1.1.00\n- wrong\n', '1.1.0')).toBeNull();
  });
});

describe('previousTag', () => {
  const TAGS = ['v1.0.0-rc.1', 'v1.0.0', 'v1.0.1-rc.1', 'v1.1.0-rc.1', 'v1.1.0-rc.2', 'v1.1.0'];

  it("is the stable release before a stable one, all the candidates between included", () => {
    expect(previousTag(TAGS, 'v1.1.0')).toBe('v1.0.0');
  });

  it('is the tag just before a candidate', () => {
    expect(previousTag(TAGS, 'v1.1.0-rc.2')).toBe('v1.1.0-rc.1');
    expect(previousTag(TAGS, 'v1.1.0-rc.1')).toBe('v1.0.1-rc.1');
  });

  it('is null for the first release', () => {
    expect(previousTag(TAGS, 'v1.0.0-rc.1')).toBeNull();
    expect(previousTag(TAGS, 'v1.0.0')).toBeNull();
  });

  it('refuses a tag that does not exist', () => {
    expect(() => previousTag(TAGS, 'v2.0.0')).toThrow('No such tag');
  });
});

describe('releasePage', () => {
  it("is what's new, then the changes, then the comparison", () => {
    expect(releasePage({
      notes: '- New.', previous: 'v1.0.0', tag: 'v1.1.0', changes: '\n#### Fixes\n\n- a (abc1234)\n',
      projectUrl: 'https://example.test/group/app',
    })).toBe(
      "### What's new\n\n- New.\n\n### Changes since v1.0.0\n\n#### Fixes\n\n- a (abc1234)\n\n"
      + '[Compare v1.0.0...v1.1.0](https://example.test/group/app/-/compare/v1.0.0...v1.1.0)\n',
    );
  });

  it('has no comparison for the first release', () => {
    expect(releasePage({ notes: '- New.', previous: null, tag: 'v1.0.0', changes: '- a (abc1234)' }))
      .toBe("### What's new\n\n- New.\n\n### Changes\n\n- a (abc1234)\n");
  });
});

describe('feedNotes', () => {
  it('reads back, through electron-updater, as the notes exactly as written', () => {
    const notes = whatsNew(NOTES, '1.1.0') as string;
    // The Windows feed as the release job writes it, then the notes.
    const feed = 'version: 1.1.0\npath: Philibert-Setup-1.1.0.exe\nsha512: abc\nreleaseDate: 2026-11-16T10:00:00Z\n'
      + feedNotes(notes);

    const info = parseUpdateInfo(feed, 'latest.yml', new URL('https://example.test/latest.yml'));

    expect(info.releaseNotes).toBe(notes);
    expect(info.version).toBe('1.1.0');
  });
});

// Real processes, git and git-cliff, each test about a second alone: given the machine's time (see real-disk).
describe('the command, in a repository', { timeout: REAL_DISK_TEST_TIMEOUT_MS }, () => {
  let repo: string;

  function git(...args: string[]): void {
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], { cwd: repo });
  }

  function commitAndTag(subject: string, tag?: string): void {
    git('commit', '--allow-empty', '-q', '-m', subject);
    if (tag) git('tag', tag);
  }

  function run(command: string, tag: string): string {
    return execFileSync('node', [SCRIPT, command, tag], {
      cwd: repo, encoding: 'utf8', env: { ...process.env, CI_PROJECT_URL: '' },
    });
  }

  /** The release page's changes: each group's heading and its entries, the commit ids left out. */
  function changes(page: string): string[] {
    const list = page.slice(page.indexOf('### Changes'));
    return list.split('\n')
      .filter((line) => line.startsWith('#### ') || line.startsWith('- '))
      .map((line) => line.replace(/ \([0-9a-f]{7}\)$/, ''));
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'release-notes-'));
    git('init', '-q');
    writeFileSync(join(repo, 'RELEASE_NOTES.md'), NOTES);
    git('add', 'RELEASE_NOTES.md');
    commitAndTag('feat: first', 'v1.0.0');
    commitAndTag('feat(chat): second');
    commitAndTag('chore: bump version to 1.1.0-rc.1', 'v1.1.0-rc.1');
    commitAndTag('fix: third');
    commitAndTag('Not conventional');
    commitAndTag('chore: bump version to 1.1.0', 'v1.1.0');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('pages a stable release with its whole cycle since the stable one before, grouped by type', () => {
    const page = run('page', 'v1.1.0');
    expect(page).toContain("### What's new\n\n- **New**: something users notice.");
    expect(page).toContain('### Changes since v1.0.0');
    expect(changes(page)).toEqual([
      '#### Features', '- **chat**: second',
      '#### Fixes', '- third',
      '#### Other', '- Not conventional',
    ]);
  });

  it('pages a candidate with the notes of the version it leads to, and its own changes', () => {
    const page = run('page', 'v1.1.0-rc.1');
    expect(page).toContain('- **New**: something users notice.');
    expect(page).toContain('### Changes since v1.0.0');
    expect(changes(page)).toEqual(['#### Features', '- **chat**: second']);
  });

  it('pages the first release with everything before it', () => {
    git('checkout', '-q', 'v1.0.0');
    writeFileSync(join(repo, 'RELEASE_NOTES.md'), '## 1.0.0\n\n- First release.\n');
    const page = run('page', 'v1.0.0');
    expect(page).toContain('### Changes\n');
    expect(changes(page)).toEqual(['#### Features', '- first']);
  });

  it('fails, saying what to write, for a version RELEASE_NOTES.md has no notes for', () => {
    commitAndTag('feat: fourth', 'v1.2.0');
    expect(() => execFileSync('node', [SCRIPT, 'check', 'v1.2.0'], { cwd: repo, stdio: 'pipe' }))
      .toThrow('RELEASE_NOTES.md has no "## 1.2.0" section');
    expect(run('check', 'v1.1.0')).toBe('');
  });
});
