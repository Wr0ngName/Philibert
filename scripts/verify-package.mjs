#!/usr/bin/env node
/**
 * Check a packaged app is complete, before anything is made from it.
 *
 * Usage: node scripts/verify-package.mjs <packageDir> <platform>
 *
 * ── Why this is not inside Forge ──
 * Forge's packageAfterPrune hook installs the external modules the Vite
 * plugin leaves out. In v0.21.0-rc.1's pipeline the npm child was killed
 * mid-install by the OOM killer, the rejection never reached Forge, and
 * packaging reported SUCCESS with two of three modules missing. The `&&`
 * chain then ran electron-builder, which failed with
 *
 *   ENOENT: no such file or directory, copyfile
 *     '…/nsis-3.0.4.1/elevate.exe' -> '…/resources/elevate.exe'
 *
 * — the destination directory did not exist — which reads as an NSIS fault
 * and cost a long detour.
 *
 * A check *inside* the hook cannot catch that: it would sit after the `await`
 * that never returns. So the check lives here, in the shell chain between
 * packaging and making, where nothing Forge does can swallow it. A non-zero
 * exit breaks the chain.
 *
 * ── How completeness is established ──
 * The hook writes a manifest as its very last action. Its absence therefore
 * means the hook did not finish, which is precisely the failure above — no
 * guessing at Forge's internals required. The manifest also names the modules
 * it installed, derived from the Vite config rather than a hand-kept list, and
 * each is then confirmed present in the package.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Where the Forge hook leaves its manifest. Keep in step with forge.config.ts. */
export function manifestPathFor(platform) {
  return join('out', `.philibert-externals-${platform}.json`);
}

/**
 * Directories a module is most likely to be in, tried before searching.
 *
 * Only a fast path: asar packing moves the app, and `asar.unpack` decides
 * which modules stay on disk, so these are an optimisation and never the
 * basis for a failure. If none match, the whole package is searched.
 */
function likelyRoots(packageDir) {
  return [
    join(packageDir, 'resources', 'app.asar.unpacked', 'node_modules'),
    join(packageDir, 'resources', 'app', 'node_modules'),
    join(packageDir, 'resources', 'node_modules'),
  ];
}

/** Whether `dir` contains a usable module directory called `name`. */
function hasModule(dir, name) {
  const candidate = join(dir, name);
  return existsSync(candidate) && statSync(candidate).isDirectory();
}

/**
 * Find a module anywhere under `root`, by looking for `node_modules/<name>`.
 *
 * Returns the containing path, or null. Breadth-first and pruned: it does not
 * descend into a matched module, and skips the heavy directories that cannot
 * contain one.
 */
function searchForModule(root, name) {
  const skip = new Set(['locales', 'swiftshader', 'chrome_crashpad_handler']);
  const queue = [root];

  while (queue.length > 0) {
    const dir = queue.shift();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory is not a verification failure
    }

    if (basename(dir) === 'node_modules' && hasModule(dir, name)) {
      return join(dir, name);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skip.has(entry.name)) continue;
      queue.push(join(dir, entry.name));
    }
  }

  return null;
}

/** Locate a module, fast path first. */
export function locateModule(packageDir, name) {
  for (const root of likelyRoots(packageDir)) {
    if (existsSync(root) && hasModule(root, name)) return join(root, name);
  }
  return searchForModule(packageDir, name);
}

/**
 * Verify a package. Returns a list of problems; empty means it is sound.
 *
 * Pure enough to test: it only reads the filesystem, so it can be pointed at
 * a synthetic tree.
 */
export function verifyPackage(packageDir, platform) {
  const problems = [];

  if (!existsSync(packageDir)) {
    problems.push(`Package directory ${packageDir} does not exist — packaging produced nothing.`);
    return problems;
  }

  const manifestPath = manifestPathFor(platform);
  if (!existsSync(manifestPath)) {
    problems.push(
      `No packaging manifest at ${manifestPath}. Forge's packageAfterPrune hook writes it as ` +
      'its last action, so it is missing because the hook did not finish — on this build host ' +
      'that is almost always the OOM killer during the external-module install. Do not chase a ' +
      'later error about a missing file: this is the cause.',
    );
    return problems;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    problems.push(`Packaging manifest ${manifestPath} is not readable JSON: ${error.message}`);
    return problems;
  }

  const modules = Array.isArray(manifest.modules) ? manifest.modules : [];
  if (modules.length === 0) {
    problems.push(
      `Packaging manifest ${manifestPath} lists no external modules, so the package cannot ` +
      'contain the Claude CLI or node-pty and the app would fail on first use.',
    );
    return problems;
  }

  for (const name of modules) {
    if (!locateModule(packageDir, name)) {
      problems.push(`External module ${name} is not in the package at ${packageDir}.`);
    }
  }

  return problems;
}

/** Run as a CLI. Importing the module does not execute this. */
function main(argv) {
  const [packageDir, platform] = argv;
  if (!packageDir || !platform) {
    console.error('usage: node scripts/verify-package.mjs <packageDir> <platform>');
    return 2;
  }

  const problems = verifyPackage(packageDir, platform);
  if (problems.length > 0) {
    console.error(`\n✖ Packaged app is incomplete (${packageDir}):\n`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('');
    return 1;
  }

  console.log(`✔ Packaged app at ${packageDir} contains every external module.`);
  return 0;
}

// Only act as a CLI when invoked directly, so the tests can import the above.
if (process.argv[1] && basename(process.argv[1]) === 'verify-package.mjs') {
  process.exit(main(process.argv.slice(2)));
}
