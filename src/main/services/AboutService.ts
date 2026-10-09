/**
 * Facts about this installation, for the About dialog.
 *
 * Everything is read from what is actually installed and running rather than
 * from constants baked in at build time: the bundled packages' own
 * package.json versions, the whisper binary's own reported version, and the
 * runtime's own numbers. A value that cannot be determined comes back null so
 * the dialog can say "unknown" — which is itself information when a component
 * is supposed to be bundled and isn't.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';

import { app } from 'electron';

import type { AboutInfo } from '../../shared/types';
import logger from '../utils/logger';
import { WindowsPaths, WhisperPaths } from '../utils/resourcePaths';

/** Give the whisper binary a moment to print its version, then give up. */
const VERSION_TIMEOUT_MS = 5000;

/** Fields read out of a package.json we care about. */
interface PackageManifest {
  version?: string;
  license?: string;
  repository?: { url?: string } | string;
}

/**
 * Read an installed dependency's own version.
 *
 * Resolves the package's manifest through the module system rather than
 * joining paths by hand, so it works inside an asar archive and wherever the
 * packager put node_modules. Returns null rather than throwing: a missing
 * optional component should render as "unknown", not break the dialog.
 */
function installedVersion(packageName: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const manifest = require(`${packageName}/package.json`) as PackageManifest;
    return manifest.version ?? null;
  } catch (error) {
    logger.debug('Could not read installed package version', { packageName, error });
    return null;
  }
}

/** The app's own manifest, for repository and licence. */
function appManifest(): PackageManifest | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(path.join(app.getAppPath(), 'package.json')) as PackageManifest;
  } catch (error) {
    logger.debug('Could not read app manifest', { error });
    return null;
  }
}

/**
 * Normalise a manifest repository field to a URL a browser can open.
 *
 * Exported because this is logic rather than wiring: a manifest may carry a
 * bare string or an object, and either may be prefixed `git+` or suffixed
 * `.git`, neither of which belongs in a link.
 */
export function normaliseRepositoryUrl(
  repository: PackageManifest['repository'] | undefined,
): string | null {
  if (!repository) return null;
  const url = typeof repository === 'string' ? repository : repository.url;
  if (!url) return null;
  return url.replace(/^git\+/, '').replace(/\.git$/, '');
}

/**
 * Pull the version out of `whisper-cli --version` output.
 *
 * It prints "whisper.cpp version: v1.9.5". Exported and tested separately
 * because a format change here would silently show the whole line, or
 * nothing, in the dialog.
 */
export function parseWhisperVersion(stdout: string): string | null {
  const match = /version:\s*(\S+)/i.exec(stdout);
  if (match) return match[1];
  const trimmed = stdout.trim();
  return trimmed || null;
}

/**
 * Ask the bundled whisper binary which version it is.
 *
 * Running the binary rather than reporting the version CI pinned: the pinned
 * value lives in the CI config and is not present at runtime, and what
 * matters is what actually shipped. `--version` prints one line and exits, so
 * this is cheap.
 */
function whisperVersion(binaryPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(binaryPath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });

    let stdout = '';
    let settled = false;

    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, VERSION_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      finish(parseWhisperVersion(stdout));
    });
  });
}

/** Collect everything the About dialog shows. */
export async function collectAboutInfo(): Promise<AboutInfo> {
  const manifest = appManifest();
  const whisperBinaryPath = WhisperPaths.findBundledBinary();

  return {
    appVersion: app.getVersion(),
    agentSdkVersion: installedVersion('@anthropic-ai/claude-agent-sdk'),
    claudeCodeVersion: installedVersion('@anthropic-ai/claude-code'),
    whisperVersion: whisperBinaryPath ? await whisperVersion(whisperBinaryPath) : null,
    whisperBinaryPath,
    electronVersion: process.versions.electron ?? 'unknown',
    chromeVersion: process.versions.chrome ?? 'unknown',
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    // Only Windows builds carry the marker; elsewhere there is no such notion.
    bundleType: process.platform === 'win32' ? WindowsPaths.getBundleType() : null,
    repositoryUrl: normaliseRepositoryUrl(manifest?.repository),
    license: manifest?.license ?? null,
    userDataPath: app.getPath('userData'),
    logPath: path.join(app.getPath('userData'), 'logs', 'main.log'),
  };
}
