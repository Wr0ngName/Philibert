/**
 * The packaging completeness check.
 *
 * This is the guard that replaced an in-hook one which could not work: on an
 * OOM the npm child dies, Forge never resumes the hook, so nothing after the
 * `await` runs — including any check placed there. The check therefore lives
 * outside Forge and keys off a manifest the hook writes last, so "hook did not
 * finish" is detectable at all.
 *
 * Exercised against synthetic package trees. A real package is ~550MB and
 * takes 10 minutes to build, which is no basis for a test, and the logic is
 * only filesystem reads.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { locateModule, manifestPathFor, verifyPackage } from '../../../scripts/verify-package.mjs';

const MODULES = ['node-pty', '@anthropic-ai/claude-code', '@anthropic-ai/claude-agent-sdk'];

let workDir: string;
let originalCwd: string;

/** Build a package tree with the given modules present. */
function makePackage(packageDir: string, modules: string[], layout = 'unpacked'): void {
  const root =
    layout === 'unpacked'
      ? join(packageDir, 'resources', 'app.asar.unpacked', 'node_modules')
      : join(packageDir, 'resources', 'app', 'node_modules');

  // Created unconditionally: a package with no modules is a case under test,
  // and resources/ still has to exist for it.
  mkdirSync(join(packageDir, 'resources'), { recursive: true });

  for (const name of modules) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }));
  }
  writeFileSync(join(packageDir, 'resources', 'app.asar'), 'asar');
}

function writeManifest(platform: string, modules: string[]): void {
  const target = manifestPathFor(platform);
  mkdirSync(join(workDir, 'out'), { recursive: true });
  writeFileSync(join(workDir, target), JSON.stringify({ platform, modules }));
}

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), 'philibert-verify-'));
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

describe('a sound package', () => {
  it('passes when the manifest and every module are present', () => {
    const packageDir = join(workDir, 'out', 'Philibert-win32-x64');
    makePackage(packageDir, MODULES);
    writeManifest('win32', MODULES);

    expect(verifyPackage(packageDir, 'win32')).toEqual([]);
  });

  it('passes when asar left the app unpacked under a different root', () => {
    // The fast path guesses a couple of layouts; a miss must fall back to
    // searching, not to failing.
    const packageDir = join(workDir, 'out', 'Philibert-linux-x64');
    makePackage(packageDir, MODULES, 'app');
    writeManifest('linux', MODULES);

    expect(verifyPackage(packageDir, 'linux')).toEqual([]);
  });

  it('finds a module in an unexpected location by searching', () => {
    const packageDir = join(workDir, 'out', 'Philibert-win32-x64');
    makePackage(packageDir, []);
    const odd = join(packageDir, 'resources', 'deep', 'nested', 'node_modules', 'node-pty');
    mkdirSync(odd, { recursive: true });

    expect(locateModule(packageDir, 'node-pty')).toContain('node-pty');
  });
});

describe('the failure this guard exists for', () => {
  it('fails when the hook never finished, naming the cause', () => {
    // The OOM case: packaging "succeeded", the modules are missing, and no
    // manifest was written because execution stopped mid-hook.
    const packageDir = join(workDir, 'out', 'Philibert-win32-x64');
    makePackage(packageDir, []);

    const problems = verifyPackage(packageDir, 'win32');

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('No packaging manifest');
    expect(problems[0]).toContain('OOM killer');
    // It must also stop the reader chasing the downstream symptom.
    expect(problems[0]).toContain('Do not chase a later error');
  });

  it('fails when a module named in the manifest is absent', () => {
    const packageDir = join(workDir, 'out', 'Philibert-win32-x64');
    makePackage(packageDir, ['node-pty']);
    writeManifest('win32', MODULES);

    const problems = verifyPackage(packageDir, 'win32');

    expect(problems).toHaveLength(2);
    expect(problems.join(' ')).toContain('@anthropic-ai/claude-code');
    expect(problems.join(' ')).toContain('@anthropic-ai/claude-agent-sdk');
  });

  it('fails when packaging produced no directory at all', () => {
    const problems = verifyPackage(join(workDir, 'out', 'Philibert-win32-x64'), 'win32');

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('does not exist');
  });

  it('fails when the manifest lists nothing', () => {
    // An empty list would otherwise pass vacuously, which is how a guard
    // becomes decoration.
    const packageDir = join(workDir, 'out', 'Philibert-win32-x64');
    makePackage(packageDir, MODULES);
    writeManifest('win32', []);

    expect(verifyPackage(packageDir, 'win32')[0]).toContain('lists no external modules');
  });

  it('fails on an unreadable manifest rather than passing', () => {
    const packageDir = join(workDir, 'out', 'Philibert-win32-x64');
    makePackage(packageDir, MODULES);
    mkdirSync(join(workDir, 'out'), { recursive: true });
    writeFileSync(join(workDir, manifestPathFor('win32')), 'not json');

    expect(verifyPackage(packageDir, 'win32')[0]).toContain('not readable JSON');
  });

  it('does not accept another platform\'s manifest', () => {
    // Each platform writes its own, so a stale one from a previous local
    // build cannot vouch for this package.
    const packageDir = join(workDir, 'out', 'Philibert-win32-x64');
    makePackage(packageDir, MODULES);
    writeManifest('linux', MODULES);

    expect(verifyPackage(packageDir, 'win32')[0]).toContain('No packaging manifest');
  });
});
