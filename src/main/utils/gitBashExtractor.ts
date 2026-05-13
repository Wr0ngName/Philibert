/**
 * Git Bash extraction utility for Windows.
 *
 * Extracts the bundled git-bash.tar.bz2 on first run or when the bundled
 * version changes.  For "All Users" installs the resources directory is
 * under C:\Program Files\ (not writable by regular users), so extraction
 * falls back to app.getPath('userData').
 */

import * as fs from 'fs';
import * as path from 'path';

import { extractTarBz2 } from './archiveExtractor';
import { debugLog } from './debugLog';
import logger from './logger';
import { WindowsPaths } from './resourcePaths';

export function extractGitBashIfNeeded(): void {
  if (process.platform !== 'win32') {
    return;
  }

  try {
    const gitBashArchive = WindowsPaths.getGitBashArchive();
    const bundledVersionFile = WindowsPaths.getGitBashVersionFile();

    debugLog(`Git Bash extraction: checking ${gitBashArchive}`);

    const extractedDir = WindowsPaths.getGitBashExtractionDir();

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
    const extractedVersionFile = path.join(extractedDir, '.version');
    const bashExePath = path.join(extractedDir, 'usr', 'bin', 'bash.exe');

    if (fs.existsSync(bashExePath) && fs.existsSync(extractedVersionFile)) {
      try {
        const bundledVersion = fs.existsSync(bundledVersionFile)
          ? fs.readFileSync(bundledVersionFile, 'utf8').trim()
          : '';
        const extractedVersion = fs.readFileSync(extractedVersionFile, 'utf8').trim();

        if (bundledVersion === extractedVersion) {
          debugLog(`Git Bash already extracted with version ${extractedVersion}`);
          return;
        }
        debugLog(`Git Bash version mismatch: bundled=${bundledVersion}, extracted=${extractedVersion}`);
      } catch (err) {
        debugLog(`Error reading version files: ${err}`);
      }
    }

    logger.info('Extracting Git Bash', { target: extractedDir, resourcesWritable: WindowsPaths.isResourcesWritable() });
    debugLog(`Extracting Git Bash to ${extractedDir}...`);

    if (fs.existsSync(extractedDir)) {
      fs.rmSync(extractedDir, { recursive: true, force: true });
    }

    extractTarBz2(archivePath, extractedDir);

    if (fs.existsSync(bundledVersionFile)) {
      const version = fs.readFileSync(bundledVersionFile, 'utf8').trim();
      fs.writeFileSync(extractedVersionFile, version);
      logger.info('Git Bash extracted successfully', { version, dir: extractedDir });
      debugLog(`Git Bash extracted successfully, version ${version}`);
    } else {
      logger.info('Git Bash extracted successfully (no version file)', { dir: extractedDir });
      debugLog('Git Bash extracted successfully (no version file)');
    }

    if (fs.existsSync(bashExePath)) {
      debugLog(`Verified: ${bashExePath} exists`);
    } else {
      logger.error('bash.exe not found after extraction', { expected: bashExePath });
      debugLog(`WARNING: ${bashExePath} not found after extraction`);
    }
  } catch (err) {
    logger.error('Git Bash extraction failed', err);
    debugLog(`Git Bash extraction failed: ${err}`);
  }
}
