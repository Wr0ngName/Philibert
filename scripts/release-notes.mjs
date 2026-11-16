/**
 * A release's notes: what's new for the people who use it, from
 * RELEASE_NOTES.md, and the changes it is made of, listed by git-cliff.
 *
 *   node scripts/release-notes.mjs check <tag>  fails when RELEASE_NOTES.md has no notes for it
 *   node scripts/release-notes.mjs feed <tag>   the update feed's releaseNotes, as YAML
 *   node scripts/release-notes.mjs page <tag>   the release page's notes, as Markdown
 *
 * RELEASE_NOTES.md holds the release being prepared only, under its version's
 * heading: an earlier release's notes are in the file at its tag
 * (`git show v0.31.0:RELEASE_NOTES.md`). A release candidate shows the notes
 * of the version it leads to: those of 0.31.0 for v0.31.0-rc.3. The heading
 * is what stops a release going out with the notes of the one before.
 *
 * The changes are git-cliff's (cliff.toml), grouped by conventional-commit
 * type: for a stable release, those since the stable release before, its
 * candidates included; for a candidate, those since the tag just before it.
 *
 * Run from the root of the repository released: the notes and the tags are
 * read there. git-cliff is the version package.json pins, run by npx: the
 * installed one in a checkout, downloaded where nothing is installed (the
 * release job).
 *
 * Plain JavaScript, like the other scripts here: CI runs it with a bare
 * `node` and no build step.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = /^v(\d+\.\d+\.\d+)(-rc\.\d+)?$/;
const NOTES_FILE = 'RELEASE_NOTES.md';
/** This tool's own checkout: its cliff.toml, and the git-cliff version it pins. */
const TOOL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

/** A version's section of the notes, without its heading; null when it has none. */
export function whatsNew(notes, version) {
  const lines = notes.split('\n');
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

/** The update feed's releaseNotes field: a YAML literal block, kept as written. */
export function feedNotes(notes) {
  const body = notes.split('\n').map((line) => (line === '' ? '' : `  ${line}`));
  return `releaseNotes: |-\n${body.join('\n')}\n`;
}

/** The release page's notes: what's new, then the changes since the release before. */
export function releasePage({ notes, previous, tag, changes, projectUrl }) {
  const since = previous === null ? 'Changes' : `Changes since ${previous}`;
  const compare = previous !== null && projectUrl
    ? `\n\n[Compare ${previous}...${tag}](${projectUrl}/-/compare/${previous}...${tag})`
    : '';
  return `### What's new\n\n${notes}\n\n### ${since}\n\n${changes.trim() || '(none)'}${compare}\n`;
}

function notesFor(tag) {
  const version = baseVersion(tag);
  const notes = whatsNew(readFileSync(NOTES_FILE, 'utf8'), version);
  if (notes === null) {
    throw new Error(
      `${NOTES_FILE} has no "## ${version}" section, or it is empty: write what ${tag} changes for its users first.`,
    );
  }
  return notes;
}

/** The changes in a range, by git-cliff; the whole history up to HEAD when there is none. */
function changesIn(range) {
  const { devDependencies } = JSON.parse(readFileSync(join(TOOL_ROOT, 'package.json'), 'utf8'));
  return execFileSync('npx', [
    '--yes', `git-cliff@${devDependencies['git-cliff']}`,
    '--config', join(TOOL_ROOT, 'cliff.toml'),
    '--repository', process.cwd(),
    '--strip', 'all',
    ...(range ? [range] : []),
  ], { cwd: TOOL_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function main([command, tag]) {
  if (!tag || !['check', 'feed', 'page'].includes(command)) {
    throw new Error('usage: release-notes.mjs check|feed|page <tag>');
  }
  const notes = notesFor(tag);
  if (command === 'check') return '';
  if (command === 'feed') return feedNotes(notes);

  const tags = execFileSync('git', ['-c', 'versionsort.suffix=-rc', 'tag', '--list', 'v*', '--sort=v:refname'], {
    encoding: 'utf8',
  }).split('\n').filter(Boolean);
  const previous = previousTag(tags, tag);
  const changes = changesIn(previous === null ? null : `${previous}..${tag}`);
  return releasePage({ notes, previous, tag, changes, projectUrl: process.env.CI_PROJECT_URL });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`release-notes: ${error.stderr || error.message}\n`);
    process.exit(1);
  }
}
