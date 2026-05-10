/**
 * Windows first-run setup
 *
 * Runs after app is ready and window is created.
 * For online bundles, downloads Node.js and Git.
 * For all bundles, extracts git-bash from tar.bz2 if needed.
 */

import type { BrowserWindow } from 'electron';

import { debugLog } from './debugLog';
import { downloadDependenciesForOnlineInstall } from './downloadDependencies';
import { extractGitBashIfNeeded } from './gitBashExtractor';
import { WindowsPaths } from './resourcePaths';

export async function setupWindowsDependencies(mainWindow: BrowserWindow | null): Promise<void> {
  const isOnline = WindowsPaths.isOnlineBundle();
  debugLog(`Windows setup: bundle type = ${isOnline ? 'online' : 'offline'}`);

  const needsExtraction = !WindowsPaths.hasBundledGitBash();
  if (!isOnline && !needsExtraction) {
    debugLog('Offline bundle with deps already extracted, skipping setup');
    return;
  }

  if (mainWindow) {
    mainWindow.setProgressBar(2); // indeterminate
  }

  try {
    if (isOnline) {
      debugLog('Online bundle: downloading dependencies...');
      if (mainWindow) mainWindow.setTitle('Philibert — Downloading dependencies...');
      downloadDependenciesForOnlineInstall();
    }

    debugLog('Extracting git-bash if needed...');
    if (mainWindow && needsExtraction) mainWindow.setTitle('Philibert — Extracting Git Bash...');
    extractGitBashIfNeeded();
  } finally {
    if (mainWindow) {
      mainWindow.setProgressBar(-1); // remove progress
      mainWindow.setTitle('Philibert');
    }
  }

  debugLog('Windows setup complete');
}
