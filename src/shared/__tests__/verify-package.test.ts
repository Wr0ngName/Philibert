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
import { dirname, join } from 'node:path';

import { createPackage } from '@electron/asar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXECUTABLE_FORMAT, NATIVE_FILES, RUNTIME_FILES } from '../../../scripts/package-contents.mjs';
import type { PackagePlatform } from '../../../scripts/package-contents.mjs';
import { asarFiles, locateModule, manifestPathFor, verifyPackage } from '../../../scripts/verify-package.mjs';

const MODULES = ['node-pty', '@anthropic-ai/claude-code', '@anthropic-ai/claude-agent-sdk'];

/** The first bytes of an executable in each format. */
const MAGIC = { elf: '\x7fELF', pe: 'MZ\x90\x00' } as const;

let workDir: string;
let originalCwd: string;

/** The node_modules a package built by makePackage holds its modules in. */
function modulesRoot(packageDir: string, layout = 'unpacked'): string {
  return layout === 'unpacked'
    ? join(packageDir, 'resources', 'app.asar.unpacked', 'node_modules')
    : join(packageDir, 'resources', 'app', 'node_modules');
}

/**
 * Write an asar archive holding `files` (paths relative to its root), in the
 * format Electron reads: a uint32 pickle holding the header's size, then the
 * header as a pickled JSON string. The contents are not read by the check.
 */
function writeAsar(file: string, files: string[]): void {
  const tree: { files: Record<string, unknown> } = { files: {} };
  for (const path of files) {
    let node = tree;
    const parts = path.split('/');
    for (const part of parts.slice(0, -1)) {
      node.files[part] ??= { files: {} };
      node = node.files[part] as typeof tree;
    }
    node.files[parts.at(-1) as string] = { size: 0, offset: '0' };
  }
  const json = Buffer.from(JSON.stringify(tree));
  const padded = Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(8 + padded);
  header.writeUInt32LE(4 + padded, 0);
  header.writeUInt32LE(json.length, 4);
  json.copy(header, 8);
  const sizes = Buffer.alloc(8);
  sizes.writeUInt32LE(4, 0);
  sizes.writeUInt32LE(header.length, 4);
  writeFileSync(file, Buffer.concat([sizes, header]));
}

/**
 * Build a package tree with the given modules present, each holding what the
 * app needs of it on `platform` — its native files in that platform's format
 * — and nothing else, and an app.asar holding the app's own code.
 */
function makePackage(packageDir: string, modules: string[], layout = 'unpacked', platform: PackagePlatform = 'win32'): void {
  const root = modulesRoot(packageDir, layout);

  // Created unconditionally: a package with no modules is a case under test,
  // and resources/ still has to exist for it.
  mkdirSync(join(packageDir, 'resources'), { recursive: true });

  for (const name of modules) {
    for (const file of RUNTIME_FILES[name].required[platform]) {
      const path = join(root, name, file);
      mkdirSync(dirname(path), { recursive: true });
      const native = NATIVE_FILES[platform].includes(`${name}/${file}`);
      writeFileSync(path, native ? MAGIC[EXECUTABLE_FORMAT[platform]] : JSON.stringify({ name }));
    }
  }
  writeAsar(join(packageDir, 'resources', 'app.asar'), ['package.json', '.vite/build/index.js']);
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
    makePackage(packageDir, MODULES, 'app', 'linux');
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

    // Each absent module, and the files the app needs of them.
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('External module @anthropic-ai/claude-code is not in the package');
    expect(problems[1]).toContain('External module @anthropic-ai/claude-agent-sdk is not in the package');
    expect(problems[2]).toContain('@anthropic-ai/claude-code/bin/claude.exe');
    expect(problems[2]).toContain('@anthropic-ai/claude-agent-sdk/sdk.mjs');
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

// Each case below is what 0.25.14-rc.1's packages held: 1,400 module files
// the app does not use on disk, 7,300 in app.asar, and in the Windows
// installer the build host's Linux binaries.
describe('what a package holds beyond what the app uses', () => {
  const packageDir = () => join(workDir, 'out', 'Philibert-win32-x64');

  beforeEach(() => {
    makePackage(packageDir(), MODULES);
    writeManifest('win32', MODULES);
  });

  it('fails on a second copy of the Claude binary, naming it', () => {
    const copy = join(modulesRoot(packageDir()), '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude');
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, MAGIC.elf);

    const problems = verifyPackage(packageDir(), 'win32');

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('1 file(s) the app does not use on win32');
    expect(problems[0]).toContain('@anthropic-ai/claude-agent-sdk-linux-x64/claude');
  });

  it('fails on a kept module\'s files the app does not load', () => {
    for (const file of ['src/unix/pty.cc', 'prebuilds/win32-x64/pty.pdb', 'prebuilds/win32-arm64/pty.node', 'build/Release/pty.node']) {
      const path = join(modulesRoot(packageDir()), 'node-pty', file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'x');
    }

    const problems = verifyPackage(packageDir(), 'win32');

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('4 file(s)');
    for (const file of ['src/unix/pty.cc', 'win32-x64/pty.pdb', 'win32-arm64/pty.node', 'build/Release/pty.node']) {
      expect(problems[0]).toContain(file);
    }
  });

  it('fails on the build host\'s Claude binary in place of the target\'s', () => {
    writeFileSync(join(modulesRoot(packageDir()), '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), MAGIC.elf);

    expect(verifyPackage(packageDir(), 'win32')).toEqual([
      'A native file is not built for win32: @anthropic-ai/claude-code/bin/claude.exe is elf, not pe.',
    ]);
  });

  it('fails on a needed file trimmed away', () => {
    rmSync(join(modulesRoot(packageDir()), 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'));

    expect(verifyPackage(packageDir(), 'win32')).toEqual([
      'Files the app needs on win32 are missing: node-pty/prebuilds/win32-x64/conpty.node.',
    ]);
  });

  it('fails on modules packed into app.asar: the bundles hold their code', () => {
    writeAsar(join(packageDir(), 'resources', 'app.asar'), [
      'package.json', '.vite/build/index.js', 'node_modules/vue/index.js', 'node_modules/.bin/marked',
    ]);

    const problems = verifyPackage(packageDir(), 'win32');

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('2 module file(s) the app does not use are in app.asar');
    expect(problems[0]).toContain('vue/index.js');
  });

  it('names the first files and counts the rest, rather than printing thousands', () => {
    for (let i = 0; i < 25; i++) {
      const path = join(modulesRoot(packageDir()), 'unused', `${i}.js`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'x');
    }

    expect(verifyPackage(packageDir(), 'win32')[0]).toContain('and 15 more');
  });
});

describe('reading an asar archive', () => {
  it('lists the files of one made by Electron\'s own tool, as Electron reads them', async () => {
    // The fixture writer above follows the format; this pins the reader to
    // the archives packaging really makes.
    const source = join(workDir, 'app');
    for (const file of ['package.json', '.vite/build/index.js', 'node_modules/node-pty/lib/index.js']) {
      mkdirSync(dirname(join(source, file)), { recursive: true });
      writeFileSync(join(source, file), 'content');
    }
    await createPackage(source, join(workDir, 'app.asar'));

    expect(asarFiles(join(workDir, 'app.asar')).sort()).toEqual([
      '.vite/build/index.js', 'node_modules/node-pty/lib/index.js', 'package.json',
    ]);
  });
});
