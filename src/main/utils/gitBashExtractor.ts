/**
 * Git Bash extraction utility for Windows.
 *
 * Extracts the bundled git-bash.tar.bz2 to resources/git-bash/ on first run
 * or when the bundled version changes.
 */

import * as fs from 'fs';

import { extractTarBz2 } from './archiveExtractor';
import { debugLog } from './debugLog';
import { WindowsPaths } from './resourcePaths';

/**
 * Extract git-bash.tar.bz2 to resources/git-bash/ if needed.
 * Skips extraction if already extracted with the same version.
 */
export function extractGitBashIfNeeded(): void {
  if (process.platform !== 'win32') {
    return;
  }

  try {
    const gitBashArchive = WindowsPaths.getGitBashArchive();
    const bundledVersionFile = WindowsPaths.getGitBashVersionFile();
    const extractedDir = WindowsPaths.getGitBashDir();
    const extractedVersionFile = WindowsPaths.getExtractedVersionFile();
    const bashExePath = WindowsPaths.getBashExe();

    debugLog(`Git Bash extraction: checking ${gitBashArchive}`);

    if (!fs.existsSync(gitBashArchive)) {
      debugLog('Git Bash archive not found, skipping extraction');
      return;
    }

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

    debugLog(`Extracting Git Bash to ${extractedDir}...`);

    if (fs.existsSync(extractedDir)) {
      fs.rmSync(extractedDir, { recursive: true, force: true });
    }

    extractTarBz2(gitBashArchive, extractedDir);

    if (fs.existsSync(bundledVersionFile)) {
      const version = fs.readFileSync(bundledVersionFile, 'utf8').trim();
      fs.writeFileSync(extractedVersionFile, version);
      debugLog(`Git Bash extracted successfully, version ${version}`);
    } else {
      debugLog('Git Bash extracted successfully (no version file)');
    }

    if (fs.existsSync(bashExePath)) {
      debugLog(`Verified: ${bashExePath} exists`);
    } else {
      debugLog(`WARNING: ${bashExePath} not found after extraction`);
    }
  } catch (err) {
    debugLog(`Git Bash extraction failed: ${err}`);
  }
}
