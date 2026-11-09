/**
 * What the packaging hook leaves of the external modules: what the app uses
 * on the target platform, and nothing else (scripts/package-contents.mjs).
 *
 * Exercised on synthetic node_modules trees shaped like the ones 0.25.14-rc.1
 * shipped; the real check of a real package runs in CI
 * (scripts/verify-package.mjs).
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  executableFormatOf,
  foreignExecutables,
  missingFiles,
  modulesWithoutRuntimeFiles,
  trimToRuntime,
  unexpectedFiles,
} from '../../../scripts/package-contents.mjs';

let modules: string;

function put(file: string, content = 'x'): void {
  mkdirSync(dirname(join(modules, file)), { recursive: true });
  writeFileSync(join(modules, file), content);
}

/** Every file left under node_modules, sorted. */
function left(): string[] {
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), file);
      else files.push(file);
    }
  };
  walk(modules, '');
  return files.sort();
}

beforeEach(() => {
  modules = join(mkdtempSync(join(tmpdir(), 'philibert-contents-')), 'node_modules');
  mkdirSync(modules);
});

afterEach(() => {
  rmSync(dirname(modules), { recursive: true, force: true });
});

/** What the install puts in node_modules for a Windows package, abridged. */
function installedForWindows(): void {
  put('node-pty/package.json');
  put('node-pty/LICENSE');
  put('node-pty/lib/index.js');
  put('node-pty/lib/index.js.map');
  put('node-pty/lib/terminal.test.js');
  put('node-pty/lib/worker/conoutSocketWorker.js');
  put('node-pty/build/Release/pty.node', '\x7fELF');
  put('node-pty/build/Makefile');
  put('node-pty/src/unix/pty.cc');
  put('node-pty/deps/winpty/x.h');
  put('node-pty/prebuilds/win32-x64/pty.node', 'MZ');
  put('node-pty/prebuilds/win32-x64/conpty.node', 'MZ');
  put('node-pty/prebuilds/win32-x64/conpty/conpty.dll', 'MZ');
  put('node-pty/prebuilds/win32-x64/winpty-agent.exe', 'MZ');
  put('node-pty/prebuilds/win32-x64/pty.pdb');
  put('node-pty/prebuilds/win32-arm64/pty.node', 'MZ');
  put('node-pty/prebuilds/darwin-arm64/pty.node');
  put('@anthropic-ai/claude-code/package.json');
  put('@anthropic-ai/claude-code/LICENSE.md');
  put('@anthropic-ai/claude-code/bin/claude.exe', 'MZ');
  put('@anthropic-ai/claude-code/install.cjs');
  put('@anthropic-ai/claude-code/sdk-tools.d.ts');
  put('@anthropic-ai/claude-code-win32-x64/claude.exe', 'MZ');
  put('@anthropic-ai/claude-agent-sdk/package.json');
  put('@anthropic-ai/claude-agent-sdk/sdk.mjs');
  put('@anthropic-ai/claude-agent-sdk/bridge.mjs');
  put('@anthropic-ai/claude-agent-sdk/sdk.d.ts');
  put('@anthropic-ai/claude-agent-sdk-linux-x64/claude', '\x7fELF');
  put('vue/index.js');
  put('.bin/marked');
  put('.package-lock.json');
}

describe('trimming a package to what the app uses', () => {
  it('leaves only what a Windows package runs', () => {
    installedForWindows();

    trimToRuntime(modules, 'win32');

    expect(left()).toEqual([
      '@anthropic-ai/claude-agent-sdk/package.json',
      '@anthropic-ai/claude-agent-sdk/sdk.mjs',
      '@anthropic-ai/claude-code/LICENSE.md',
      '@anthropic-ai/claude-code/bin/claude.exe',
      '@anthropic-ai/claude-code/package.json',
      'node-pty/LICENSE',
      'node-pty/lib/index.js',
      'node-pty/lib/worker/conoutSocketWorker.js',
      'node-pty/package.json',
      'node-pty/prebuilds/win32-x64/conpty.node',
      'node-pty/prebuilds/win32-x64/conpty/conpty.dll',
      'node-pty/prebuilds/win32-x64/pty.node',
      'node-pty/prebuilds/win32-x64/winpty-agent.exe',
    ]);
    // Emptied directories go too.
    expect(existsSync(join(modules, 'vue'))).toBe(false);
    expect(existsSync(join(modules, 'node-pty', 'src'))).toBe(false);
    expect(existsSync(join(modules, '@anthropic-ai', 'claude-code-win32-x64'))).toBe(false);
  });

  it('leaves only what a Linux package runs', () => {
    installedForWindows();

    trimToRuntime(modules, 'linux');

    expect(left().filter((file) => file.startsWith('node-pty/'))).toEqual([
      'node-pty/LICENSE',
      'node-pty/build/Release/pty.node',
      'node-pty/lib/index.js',
      'node-pty/lib/worker/conoutSocketWorker.js',
      'node-pty/package.json',
    ]);
  });

  it('says how much it removed', () => {
    installedForWindows();
    put('vue/big.js', 'y'.repeat(1000));

    expect(trimToRuntime(modules, 'win32')).toBeGreaterThanOrEqual(1000);
  });

  it('refuses a result missing a file the app needs, naming it', () => {
    installedForWindows();
    rmSync(join(modules, '@anthropic-ai/claude-code/bin/claude.exe'));

    expect(() => trimToRuntime(modules, 'win32')).toThrow('@anthropic-ai/claude-code/bin/claude.exe');
  });
});

describe('checking a package', () => {
  it('finds nothing amiss once trimmed', () => {
    installedForWindows();
    trimToRuntime(modules, 'win32');

    expect(unexpectedFiles(modules, 'win32')).toEqual([]);
    expect(missingFiles(modules, 'win32')).toEqual([]);
    expect(foreignExecutables(modules, 'win32')).toEqual([]);
  });

  it('names a file the app does not use', () => {
    installedForWindows();

    expect(unexpectedFiles(modules, 'win32')).toContain('@anthropic-ai/claude-agent-sdk-linux-x64/claude');
  });

  it('knows an executable\'s format by its first bytes', () => {
    put('a', '\x7fELF\x02');
    put('b', 'MZ\x90');
    put('c', '#!/bin/sh');

    expect([executableFormatOf(join(modules, 'a')), executableFormatOf(join(modules, 'b')), executableFormatOf(join(modules, 'c'))])
      .toEqual(['elf', 'pe', null]);
  });

  it('finds the build host\'s binary in another platform\'s package', () => {
    put('@anthropic-ai/claude-code/bin/claude.exe', '\x7fELF');
    put('node-pty/prebuilds/win32-x64/pty.node', 'MZ');

    expect(foreignExecutables(modules, 'win32')).toEqual(['@anthropic-ai/claude-code/bin/claude.exe is elf, not pe']);
  });

  it('names an external module nothing says the files of', () => {
    expect(modulesWithoutRuntimeFiles(['node-pty', 'better-sqlite3'])).toEqual(['better-sqlite3']);
  });
});
