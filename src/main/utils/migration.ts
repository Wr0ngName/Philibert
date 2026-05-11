import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import { debugLog } from './debugLog';

// Electron uses productName for app.getName() → app.getPath('userData')
// Old productName was "Cline GUI" (with space)
const OLD_APP_NAME = 'Cline GUI';

function getOldUserDataPath(): string {
  const currentPath = app.getPath('userData');
  return path.join(path.dirname(currentPath), OLD_APP_NAME);
}

function getOldUpdaterCachePath(): string | null {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, `${OLD_APP_NAME}-updater`);
  }
  return null;
}

/**
 * Migrate user data from old "Cline GUI" app to new "Philibert" app.
 * Runs once on first launch — skips if new app already has data or old data doesn't exist.
 * Uses sync operations because this must complete before ConfigService reads config.
 *
 * On Linux, safeStorage encrypted credentials (API key, OAuth token) cannot be migrated
 * because the encryption key is tied to the app name in the OS keyring. Users will need
 * to re-authenticate. On Windows, DPAPI is user-scoped so credentials migrate fine.
 */
export function migrateFromOldApp(): void {
  const oldPath = getOldUserDataPath();
  const newPath = app.getPath('userData');

  if (!fs.existsSync(oldPath)) {
    debugLog('Migration: no old "Cline GUI" data found, skipping');
    return;
  }

  const newConfig = path.join(newPath, 'config.json');
  if (fs.existsSync(newConfig)) {
    debugLog('Migration: Philibert config already exists, skipping');
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
    debugLog('Migration: removed old "Cline GUI" userData directory');
  } catch (err) {
    debugLog(`Migration: failed to remove old userData directory (non-critical): ${err}`);
  }

  // Windows: clean up old electron-updater cache in %LOCALAPPDATA%
  const oldUpdaterCache = getOldUpdaterCachePath();
  if (oldUpdaterCache && fs.existsSync(oldUpdaterCache)) {
    try {
      fs.rmSync(oldUpdaterCache, { recursive: true, force: true });
      debugLog(`Migration: removed old updater cache at ${oldUpdaterCache}`);
    } catch (err) {
      debugLog(`Migration: failed to remove old updater cache (non-critical): ${err}`);
    }
  }

  debugLog('Migration: complete');
}
