/**
 * A release's notes: what's new for the people who use it, from CHANGELOG.md,
 * and the list of changes it is made of, from git.
 *
 *   node scripts/release-notes.mjs check <tag>  fails when CHANGELOG.md has no section for it
 *   node scripts/release-notes.mjs feed <tag>   the update feed's releaseNotes, as YAML
 *   node scripts/release-notes.mjs page <tag>   the release page's notes, as Markdown
 *
 * A release candidate shows the section of the version it leads to: the
 * notes of 0.31.0 for v0.31.0-rc.3. Its changes are those since the tag
 * before it; a stable release's, those since the stable release before it,
 * all its candidates included.
 *
 * Run from the repository's root: CHANGELOG.md and the tags are read there.
 *
 * Plain JavaScript, like the other scripts here: CI runs it with a bare
 * `node` and no build step.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TAG = /^v(\d+\.\d+\.\d+)(-rc\.\d+)?$/;

/** The version a tag leads to: 0.31.0 for v0.31.0 and for v0.31.0-rc.3. */
export function baseVersion(tag) {
  const match = TAG.exec(tag);
  if (!match) throw new Error(`Not a release tag: "${tag}"`);
  return match[1];
}

/** Whether a tag is a stable release, not a candidate. */
export function isStable(tag) {
  baseVersion(tag);
  return !tag.includes('-rc.');
}

/** A version's section of CHANGELOG.md, without its heading; null when it has none. */
export function whatsNew(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) return null;
  const length = lines.slice(start + 1).findIndex((line) => line.startsWith('## '));
  const section = lines.slice(start + 1, length === -1 ? undefined : start + 1 + length);
  const text = section.join('\n').trim();
  return text === '' ? null : text;
}

/**
 * The tag a release's changes are counted from: the stable release before a
 * stable one, the tag just before a candidate. `tags` are in version order,
 * oldest first, as `git -c versionsort.suffix=-rc tag --sort=v:refname`
 * lists them. Null for the first release.
 */
export function previousTag(tags, tag) {
  if (!tags.includes(tag)) throw new Error(`No such tag: "${tag}"`);
  const before = tags.slice(0, tags.indexOf(tag)).filter((t) => TAG.test(t));
  const candidates = isStable(tag) ? before.filter(isStable) : before;
  return candidates.at(-1) ?? null;
}

/**
 * The changes as a Markdown list, from `git log --format=%h%x09%s` lines.
 * Version bumps are left out: they change nothing but the number.
 */
export function changesList(log) {
  return log
    .split('\n')
    .filter((line) => line.includes('\t'))
    .map((line) => line.split('\t'))
    .filter(([, subject]) => !subject.startsWith('chore: bump version to '))
    .map(([sha, subject]) => `- ${subject} (${sha})`)
    .join('\n');
}

/** The update feed's releaseNotes field: a YAML literal block, kept as written. */
export function feedNotes(notes) {
  const body = notes.split('\n').map((line) => (line === '' ? '' : `  ${line}`));
  return `releaseNotes: |-\n${body.join('\n')}\n`;
}

/** The release page's notes: what's new, then every change since the release before. */
export function releasePage({ notes, previous, tag, changes, projectUrl }) {
  const since = previous === null ? 'Changes' : `Changes since ${previous}`;
  const compare = previous !== null && projectUrl
    ? `\n\n[Compare ${previous}...${tag}](${projectUrl}/-/compare/${previous}...${tag})`
    : '';
  return `### What's new\n\n${notes}\n\n### ${since}\n\n${changes || '- (none)'}${compare}\n`;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function notesFor(tag) {
  const version = baseVersion(tag);
  const notes = whatsNew(readFileSync('CHANGELOG.md', 'utf8'), version);
  if (notes === null) {
    throw new Error(
      `CHANGELOG.md has no "## ${version}" section, or it is empty: write what ${tag} changes for its users first.`,
    );
  }
  return notes;
}

function main([command, tag]) {
  if (!tag || !['check', 'feed', 'page'].includes(command)) {
    throw new Error('usage: release-notes.mjs check|feed|page <tag>');
  }
  const notes = notesFor(tag);
  if (command === 'check') return '';
  if (command === 'feed') return feedNotes(notes);

  const tags = git('-c', 'versionsort.suffix=-rc', 'tag', '--list', 'v*', '--sort=v:refname')
    .split('\n').filter(Boolean);
  const previous = previousTag(tags, tag);
  const range = previous === null ? tag : `${previous}..${tag}`;
  const changes = changesList(git('log', '--no-merges', '--format=%h%x09%s', range));
  return releasePage({ notes, previous, tag, changes, projectUrl: process.env.CI_PROJECT_URL });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`release-notes: ${error.message}\n`);
    process.exit(1);
  }
}
