/**
 * The About dialog's facts.
 *
 * Two parts can go wrong silently and are tested directly: parsing the
 * whisper binary's `--version` output, and turning a manifest repository
 * field into something a browser can open. A wrong parse here shows the
 * whole line, or "unknown", with nothing to explain it.
 *
 * Not tested through collectAboutInfo, which asks Electron and spawns
 * whisper. The installed versions it shows are: installedVersion reads them
 * from the folders the module system looks in, which are this project's
 * node_modules here — the very packages the app bundles.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, it, expect, vi } from 'vitest';

// Module-load boundaries only: the logger reads app.getPath at import time,
// so the module cannot be imported at all without these.
vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.0.0-test'),
    getAppPath: vi.fn(() => '/app'),
    getPath: vi.fn((name: string) => `/userdata/${name}`),
  },
}));

vi.mock('../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { installedVersion, normaliseRepositoryUrl, parseWhisperVersion } from '../services/AboutService';

/** Node's require, as the old lookup used it. */
const nodeRequire = createRequire(import.meta.url);

/** A package's version as its manifest in this project's node_modules says. */
function manifestVersion(name: string): string {
  return (JSON.parse(fs.readFileSync(path.join(process.cwd(), 'node_modules', name, 'package.json'), 'utf-8')) as { version: string }).version;
}

describe('installedVersion', () => {
  // Reported: the About page said "unknown" for the agent SDK. Its manifest
  // has an exports map that does not list ./package.json, and the version
  // was read by requiring that subpath: ERR_PACKAGE_PATH_NOT_EXPORTED.
  it('reads the agent SDK, whose exports map does not list its manifest', () => {
    expect(() => nodeRequire('@anthropic-ai/claude-agent-sdk/package.json')).toThrow(/not defined by "exports"/);
    expect(installedVersion('@anthropic-ai/claude-agent-sdk')).toBe(manifestVersion('@anthropic-ai/claude-agent-sdk'));
  });

  it('reads Claude Code, which has no entry point to resolve, only a binary', () => {
    expect(installedVersion('@anthropic-ai/claude-code')).toBe(manifestVersion('@anthropic-ai/claude-code'));
  });

  it('says nothing for a package that is not installed', () => {
    expect(installedVersion('@anthropic-ai/not-a-package')).toBeNull();
  });
});

describe('parseWhisperVersion', () => {
  it('extracts the version from the real output format', () => {
    // whisper-cli prints exactly this and exits.
    expect(parseWhisperVersion('whisper.cpp version: v1.9.5\n')).toBe('v1.9.5');
  });

  it('tolerates extra whitespace', () => {
    expect(parseWhisperVersion('whisper.cpp version:    v1.9.5  \n')).toBe('v1.9.5');
  });

  it('matches case-insensitively', () => {
    expect(parseWhisperVersion('Whisper.cpp Version: v1.9.5')).toBe('v1.9.5');
  });

  it('falls back to the whole line when the format changes', () => {
    // Better to show something unexpected than to report "unknown" for a
    // binary that answered.
    expect(parseWhisperVersion('v1.9.5-custom')).toBe('v1.9.5-custom');
  });

  it('returns null for empty output', () => {
    expect(parseWhisperVersion('')).toBeNull();
    expect(parseWhisperVersion('   \n ')).toBeNull();
  });
});

describe('normaliseRepositoryUrl', () => {
  it('returns an object manifest URL unchanged when already clean', () => {
    expect(normaliseRepositoryUrl({ url: 'https://example.com/me/proj' }))
      .toBe('https://example.com/me/proj');
  });

  it('strips the .git suffix so the link opens in a browser', () => {
    // This project's own manifest carries the .git form.
    expect(normaliseRepositoryUrl({ url: 'https://dev.web.wr0ng.name/wrongname/philibert.git' }))
      .toBe('https://dev.web.wr0ng.name/wrongname/philibert');
  });

  it('strips a git+ prefix', () => {
    expect(normaliseRepositoryUrl({ url: 'git+https://example.com/me/proj.git' }))
      .toBe('https://example.com/me/proj');
  });

  it('accepts the shorthand string form', () => {
    expect(normaliseRepositoryUrl('https://example.com/me/proj.git'))
      .toBe('https://example.com/me/proj');
  });

  it('returns null when there is no repository to link to', () => {
    expect(normaliseRepositoryUrl(undefined)).toBeNull();
    expect(normaliseRepositoryUrl({})).toBeNull();
    expect(normaliseRepositoryUrl('')).toBeNull();
  });
});
