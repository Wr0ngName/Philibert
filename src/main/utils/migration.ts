import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import { debugLog } from './debugLog';

// Possible old directory names — depends on whether Electron resolved
// productName ("Cline GUI") or package.json name ("cline-gui") for userData.
// Check both rather than guessing.
const OLD_APP_NAMES = ['Cline GUI', 'cline-gui'];

function findOldUserDataPath(): string | null {
  const parentDir = path.dirname(app.getPath('userData'));
  for (const name of OLD_APP_NAMES) {
    const candidate = path.join(parentDir, name);
    if (fs.existsSync(candidate)) {
      debugLog(`Migration: found old data directory at ${candidate}`);
      return candidate;
    }
  }
  return null;
}

function cleanupOldUpdaterCaches(): void {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return;

  for (const name of OLD_APP_NAMES) {
    const cachePath = path.join(process.env.LOCALAPPDATA, `${name}-updater`);
    if (fs.existsSync(cachePath)) {
      try {
        fs.rmSync(cachePath, { recursive: true, force: true });
        debugLog(`Migration: removed old updater cache at ${cachePath}`);
      } catch (err) {
        debugLog(`Migration: failed to remove updater cache ${cachePath} (non-critical): ${err}`);
      }
    }
  }
}

/**
 * Migrate user data from old "Cline GUI" app to new "Philibert" app.
 * Runs once on first launch — skips if new app already has data or old data doesn't exist.
 * Uses sync operations because this must complete before ConfigService reads config.
 *
 * On Linux, safeStorage encrypted credentials (API key, OAuth token) cannot be migrated
 * because the encryption key is loaded once at app startup from the OS keyring, keyed by
 * app name. Changing the keyring lookup would require restarting the app or accessing the
 * keyring directly via native bindings. Users will need to re-authenticate once.
 * On Windows, DPAPI is user-scoped so credentials migrate fine.
 */
export function migrateFromOldApp(): void {
  const oldPath = findOldUserDataPath();
  const newPath = app.getPath('userData');

  if (!oldPath) {
    debugLog('Migration: no old Cline GUI data found, skipping');
    cleanupOldUpdaterCaches();
    return;
  }

  const newConfig = path.join(newPath, 'config.json');
  if (fs.existsSync(newConfig)) {
    debugLog('Migration: Philibert config already exists, skipping');
    cleanupOldUpdaterCaches();
    return;
  }

  debugLog(`Migration: migrating data from ${oldPath} to ${newPath}`);

  fs.mkdirSync(newPath, { recursive: true });

  const oldConfig = path.join(oldPath, 'config.json');
  if (fs.existsSync(oldConfig)) {
    try {
      fs.copyFileSync(oldConfig, newConfig);
      debugLog('Migration: copied config.json');
    } catch (err) {
      debugLog(`Migration: failed to copy config.json: ${err}`);
    }
  }

  const oldConversations = path.join(oldPath, 'conversations');
  const newConversations = path.join(newPath, 'conversations');
  if (fs.existsSync(oldConversations)) {
    try {
      fs.mkdirSync(newConversations, { recursive: true });
      const files = fs.readdirSync(oldConversations);
      let count = 0;
      for (const file of files) {
        if (file.endsWith('.json')) {
          fs.copyFileSync(
            path.join(oldConversations, file),
            path.join(newConversations, file)
          );
          count++;
        }
      }
      debugLog(`Migration: copied ${count} conversations`);
    } catch (err) {
      debugLog(`Migration: failed to copy conversations: ${err}`);
    }
  }

  try {
    fs.rmSync(oldPath, { recursive: true, force: true });
    debugLog(`Migration: removed old data directory at ${oldPath}`);
  } catch (err) {
    debugLog(`Migration: failed to remove old directory (non-critical): ${err}`);
  }

  cleanupOldUpdaterCaches();

  debugLog('Migration: complete');
}
