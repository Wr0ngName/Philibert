/**
 * What a packaged app ships of the modules it loads at run time.
 *
 * The Vite build bundles everything except the modules named `external` in
 * vite.main.config.ts; Forge's packageAfterPrune hook installs those into the
 * package, and this file says which of their files the app actually uses.
 * The hook removes every other file (`trimToRuntime`), and
 * scripts/verify-package.mjs fails a package holding anything else
 * (`unexpectedFiles`) or lacking what is needed (`missingFiles`).
 *
 * ── What was shipped before this, measured on 0.25.14-rc.1 ──
 *  - All of the app's production dependencies (vue, pinia, marked…), 175
 *    packages, 45 MB in app.asar: `npm install <module>` in a folder whose
 *    package.json lists them installs them all, and nothing loads them —
 *    the bundles hold their code.
 *  - The 230 MB Claude binary three or four times: the copy the app runs
 *    (claude-code/bin/claude.exe), the platform package it is copied from,
 *    the agent SDK's own copy (used only when no path is given, and the app
 *    always gives one) — and in Windows installers, the build host's Linux
 *    copies as well.
 *  - node-pty's sources, build files, Windows debug symbols and prebuilds for
 *    every other platform: 60 MB, and in Windows installers a Linux pty.node.
 *
 * ── Adding an external module ──
 * The hook refuses one that has no entry below, so what it ships is decided,
 * not inherited.
 */

import { existsSync, lstatSync, openSync, readSync, closeSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const isLicense = (file) => /^LICEN[CS]E(\.(md|txt))?$/i.test(file);

/** Whether a file of node-pty's lib is code it runs: not a test, not a source map. */
const isPtyCode = (file) => file.startsWith('lib/') && file.endsWith('.js') && !file.endsWith('.test.js');

/**
 * Per external module: the files the app cannot run without on a platform
 * (`required`), and every file it may ship (`keeps`). Paths are relative to
 * the module, with forward slashes.
 */
export const RUNTIME_FILES = {
  'node-pty': {
    // node-pty loads build/Release first, then prebuilds/<platform>-<arch>
    // (lib/utils.js, loadNativeModule). Linux has no prebuild: it is compiled
    // on the build host. Windows uses the prebuild; its conpty/, winpty and
    // agent files are loaded beside the .node files, its .pdb never.
    required: {
      linux: ['package.json', 'lib/index.js', 'build/Release/pty.node'],
      win32: ['package.json', 'lib/index.js', 'prebuilds/win32-x64/pty.node', 'prebuilds/win32-x64/conpty.node'],
    },
    keeps: (file, platform) => file === 'package.json' || isLicense(file) || isPtyCode(file)
      || (platform === 'linux' && file === 'build/Release/pty.node')
      || (platform === 'win32' && file.startsWith('prebuilds/win32-x64/') && !file.endsWith('.pdb')),
  },
  '@anthropic-ai/claude-code': {
    // The binary the app runs (ClaudeCliPaths.findBundledCli), put there by
    // the hook from the target platform's package.
    required: { linux: ['package.json', 'bin/claude.exe'], win32: ['package.json', 'bin/claude.exe'] },
    keeps: (file) => file === 'package.json' || isLicense(file) || file === 'bin/claude.exe',
  },
  '@anthropic-ai/claude-agent-sdk': {
    // Its entry point is self-contained: it imports Node's own modules only.
    required: { linux: ['package.json', 'sdk.mjs'], win32: ['package.json', 'sdk.mjs'] },
    keeps: (file) => file === 'package.json' || isLicense(file) || file === 'sdk.mjs',
  },
};

/** The executables whose format must be the target's: a build host's copy fails on first use. */
export const NATIVE_FILES = {
  linux: ['@anthropic-ai/claude-code/bin/claude.exe', 'node-pty/build/Release/pty.node'],
  win32: ['@anthropic-ai/claude-code/bin/claude.exe', 'node-pty/prebuilds/win32-x64/pty.node'],
};

/** The modules named in RUNTIME_FILES, for checking a list of externals against. */
export function modulesWithoutRuntimeFiles(modules) {
  return modules.filter((name) => !(name in RUNTIME_FILES));
}

/** Every file under `dir`, relative to it with forward slashes. Links are listed, never followed. */
function filesUnder(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(relative(dir, full).split(sep).join('/'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

/** Which module a node_modules-relative path belongs to, if any named in RUNTIME_FILES. */
function moduleOf(file) {
  return Object.keys(RUNTIME_FILES).find((name) => file.startsWith(`${name}/`)) ?? null;
}

/** Files under `nodeModulesDir` the app does not use on `platform`. */
export function unexpectedFiles(nodeModulesDir, platform) {
  return filesUnder(nodeModulesDir).filter((file) => {
    const name = moduleOf(file);
    return !name || !RUNTIME_FILES[name].keeps(file.slice(name.length + 1), platform);
  });
}

/** Files the app cannot run without on `platform`, absent from `nodeModulesDir`. */
export function missingFiles(nodeModulesDir, platform) {
  return Object.entries(RUNTIME_FILES).flatMap(([name, { required }]) => {
    const files = required[platform];
    if (!files) return [`${name}: nothing is known to be needed on ${platform}`];
    return files.map((file) => `${name}/${file}`).filter((file) => !existsSync(join(nodeModulesDir, file)));
  });
}

/** Remove a directory's empty subdirectories, deepest first. */
function removeEmptyDirectories(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirectories(join(dir, entry.name));
  }
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}

/**
 * Remove from `nodeModulesDir` every file the app does not use on
 * `platform`. Returns the bytes removed. Throws if what remains lacks a
 * needed file, so a trim that went too far never reaches a package.
 */
export function trimToRuntime(nodeModulesDir, platform) {
  let removed = 0;
  for (const file of unexpectedFiles(nodeModulesDir, platform)) {
    const full = join(nodeModulesDir, file);
    removed += lstatSync(full).size;
    rmSync(full, { force: true });
  }
  if (existsSync(nodeModulesDir)) removeEmptyDirectories(nodeModulesDir);
  const missing = missingFiles(nodeModulesDir, platform);
  if (missing.length > 0) {
    throw new Error(`The packaged modules lack files the app needs on ${platform}: ${missing.join(', ')}`);
  }
  return removed;
}

/** The executable format a file starts with: 'elf', 'pe', or null. */
export function executableFormatOf(file) {
  const head = Buffer.alloc(4);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, head, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  if (head[0] === 0x7f && head.toString('latin1', 1, 4) === 'ELF') return 'elf';
  if (head.toString('latin1', 0, 2) === 'MZ') return 'pe';
  return null;
}

/** The format each platform runs. */
export const EXECUTABLE_FORMAT = { linux: 'elf', win32: 'pe' };

/** Native files under `nodeModulesDir` not in `platform`'s format. */
export function foreignExecutables(nodeModulesDir, platform) {
  return (NATIVE_FILES[platform] ?? [])
    .filter((file) => existsSync(join(nodeModulesDir, file)))
    .map((file) => ({ file, format: executableFormatOf(join(nodeModulesDir, file)) }))
    .filter(({ format }) => format !== EXECUTABLE_FORMAT[platform])
    .map(({ file, format }) => `${file} is ${format ?? 'not an executable'}, not ${EXECUTABLE_FORMAT[platform]}`);
}
