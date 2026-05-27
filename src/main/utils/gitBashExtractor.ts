/**
 * Git Bash extraction utility for Windows.
 *
 * Extracts the bundled git-bash.tar.bz2 on first run or when the bundled
 * version changes.
 *
 * For "all users" installs (Program Files), the NSIS installer extracts
 * Git Bash during installation while elevated.  Runtime extraction only
 * applies to per-user installs where resources/ is writable.
 */

import * as fs from 'fs';
import * as path from 'path';

import { extractTarBz2 } from './archiveExtractor';
import { debugLog } from './debugLog';
import logger from './logger';
import { getResourcesPath, WindowsPaths } from './resourcePaths';

function isAlreadyExtracted(
  extractedDir: string,
  bundledVersionFile: string,
): boolean {
  const bashExePath = path.join(extractedDir, 'usr', 'bin', 'bash.exe');
  const extractedVersionFile = path.join(extractedDir, '.version');

  if (!fs.existsSync(bashExePath) || !fs.existsSync(extractedVersionFile)) {
    return false;
  }

  try {
    const bundledVersion = fs.existsSync(bundledVersionFile)
      ? fs.readFileSync(bundledVersionFile, 'utf8').trim()
      : '';
    const extractedVersion = fs.readFileSync(extractedVersionFile, 'utf8').trim();
    if (bundledVersion === extractedVersion) {
      debugLog(`Git Bash already extracted with version ${extractedVersion} at ${extractedDir}`);
      return true;
    }
    debugLog(`Git Bash version mismatch: bundled=${bundledVersion}, extracted=${extractedVersion}`);
  } catch (err) {
    debugLog(`Error reading version files: ${err}`);
  }
  return false;
}

function doExtract(archivePath: string, extractedDir: string, bundledVersionFile: string): void {
  if (fs.existsSync(extractedDir)) {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }

  fs.mkdirSync(extractedDir, { recursive: true });
  extractTarBz2(archivePath, extractedDir);

  const extractedVersionFile = path.join(extractedDir, '.version');
  if (fs.existsSync(bundledVersionFile)) {
    const version = fs.readFileSync(bundledVersionFile, 'utf8').trim();
    fs.writeFileSync(extractedVersionFile, version);
    logger.info('Git Bash extracted successfully', { version, dir: extractedDir });
    debugLog(`Git Bash extracted successfully, version ${version}`);
  } else {
    logger.info('Git Bash extracted successfully (no version file)', { dir: extractedDir });
    debugLog('Git Bash extracted successfully (no version file)');
  }

  const bashExePath = path.join(extractedDir, 'usr', 'bin', 'bash.exe');
  if (fs.existsSync(bashExePath)) {
    debugLog(`Verified: ${bashExePath} exists`);
  } else {
    logger.error('bash.exe not found after extraction', { expected: bashExePath });
    debugLog(`WARNING: ${bashExePath} not found after extraction`);
  }
}

export function extractGitBashIfNeeded(): void {
  if (process.platform !== 'win32') {
    return;
  }

  try {
    const gitBashArchive = WindowsPaths.getGitBashArchive();
    const bundledVersionFile = WindowsPaths.getGitBashVersionFile();
    const extractedDir = path.join(getResourcesPath(), 'git-bash');

    debugLog(`Git Bash extraction: checking ${gitBashArchive}`);

    // Check for archive in resources (offline builds) or next to extraction dir (online downloads)
    let archivePath = gitBashArchive;
    if (!fs.existsSync(archivePath)) {
      const fallbackArchive = path.join(path.dirname(extractedDir), 'git-bash.tar.bz2');
      if (fs.existsSync(fallbackArchive)) {
        archivePath = fallbackArchive;
      } else {
        debugLog('Git Bash archive not found, skipping extraction');
        logger.info('Git Bash archive not found, skipping extraction', {
          checked: [gitBashArchive, fallbackArchive],
        });
        return;
      }
    }

    // Skip if already extracted (e.g. by the NSIS installer during installation)
    if (isAlreadyExtracted(extractedDir, bundledVersionFile)) {
      return;
    }

    // For "all users" installs, the NSIS installer should have extracted
    // Git Bash during installation while elevated.  If it didn't (e.g. old
    // installer, manual placement), we cannot write to Program Files at
    // runtime — report the error clearly instead of silently degrading.
    if (!WindowsPaths.isResourcesWritable()) {
      logger.error(
        'Cannot extract Git Bash: resources directory is not writable. ' +
        'For system-wide installations, Git Bash should be extracted by the installer. ' +
        'Please reinstall Philibert or install Git Bash system-wide.',
        { resourcesPath: getResourcesPath(), target: extractedDir },
      );
      debugLog('Resources dir not writable — cannot extract Git Bash at runtime');
      return;
    }

    logger.info('Extracting Git Bash', { target: extractedDir });
    debugLog(`Extracting Git Bash to ${extractedDir}...`);

    try {
      doExtract(archivePath, extractedDir, bundledVersionFile);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        // isResourcesWritable() can give false positives on Windows (ACL check
        // passes but actual write fails).  Same story: not our job to work around.
        logger.error(
          'Git Bash extraction failed: permission denied despite resources appearing writable. ' +
          'This typically happens with system-wide installations. Please reinstall Philibert.',
          { error: String(err), target: extractedDir },
        );
        debugLog(`Extraction failed with ${code} — reinstallation required`);
      } else {
        throw err;
      }
    }
  } catch (err) {
    logger.error('Git Bash extraction failed', err);
    debugLog(`Git Bash extraction failed: ${err}`);
  }
}
