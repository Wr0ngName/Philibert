import fs from 'node:fs';
import path from 'node:path';

import { app, safeStorage } from 'electron';

import { debugLog } from './debugLog';

// Electron prefers productName over name for app.getName() / app.getPath('userData')
// https://www.electronjs.org/docs/latest/api/app#appgetname
const OLD_APP_NAME = 'Cline GUI';
const NEW_APP_NAME = 'Philibert';

const CREDENTIAL_KEYS = ['encryptedApiKey', 'encryptedOAuthToken'] as const;
const CREDENTIAL_TEMP_FILE = '.credential-migration.json';

function getOldUserDataPath(): string {
  return path.join(path.dirname(app.getPath('userData')), OLD_APP_NAME);
}

function getPhilibertUserDataPath(): string {
  return path.join(path.dirname(app.getPath('userData')), NEW_APP_NAME);
}

interface MigrationResult {
  needsCredentialRestart: boolean;
}

/**
 * Phase 1: Migrate user data from old "Cline GUI" app to new "Philibert" app.
 * Copies config.json and conversations, removes old directory, cleans up updater cache.
 *
 * Returns { needsCredentialRestart: true } on Linux when encrypted credentials exist
 * that require a restart to re-key (safeStorage encryption key is tied to app name
 * in the OS keyring — only Windows DPAPI is user-scoped and works across renames).
 */
export function migrateFromOldApp(): MigrationResult {
  const oldPath = getOldUserDataPath();
  const newPath = app.getPath('userData');

  if (!fs.existsSync(oldPath)) {
    debugLog('Migration: no old "Cline GUI" data found, skipping');
    cleanupOldUpdaterCache();
    return { needsCredentialRestart: false };
  }

  const newConfig = path.join(newPath, 'config.json');
  if (fs.existsSync(newConfig)) {
    debugLog('Migration: Philibert config already exists, skipping');
    cleanupOldUpdaterCache();
    return { needsCredentialRestart: false };
  }

  debugLog(`Migration: migrating data from ${oldPath} to ${newPath}`);

  fs.mkdirSync(newPath, { recursive: true });

  const oldConfig = path.join(oldPath, 'config.json');
  let hasEncryptedCredentials = false;

  if (fs.existsSync(oldConfig)) {
    try {
      fs.copyFileSync(oldConfig, newConfig);
      debugLog('Migration: copied config.json');

      const config = JSON.parse(fs.readFileSync(newConfig, 'utf8'));
      hasEncryptedCredentials = CREDENTIAL_KEYS.some(
        (key) => config[key] && !String(config[key]).startsWith('plain:')
      );
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

  cleanupOldUpdaterCache();

  // On Linux (and macOS), safeStorage key is tied to app name in the OS keyring.
  // A restart with the old app name is needed to decrypt and re-key credentials.
  // On Windows, DPAPI is user-scoped — credentials work without re-keying.
  const needsRekey = process.platform !== 'win32' && hasEncryptedCredentials;
  if (needsRekey) {
    debugLog('Migration: encrypted credentials detected, restart needed to re-key');
  }

  debugLog('Migration: phase 1 complete');
  return { needsCredentialRestart: needsRekey };
}

/**
 * Phase 2: Called on restart with --migrate-credentials flag.
 * At this point app.setName('Cline GUI') was called before ready,
 * so safeStorage has the old encryption key loaded.
 * Decrypts credentials and writes plaintext to a temp file (mode 0600) for phase 3.
 */
export function decryptOldCredentials(): void {
  const philibertPath = getPhilibertUserDataPath();
  const configPath = path.join(philibertPath, 'config.json');

  if (!fs.existsSync(configPath)) {
    debugLog('Migration phase 2: no config found at Philibert path, skipping');
    return;
  }

  if (!safeStorage.isEncryptionAvailable()) {
    debugLog('Migration phase 2: safeStorage not available, skipping');
    return;
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const decrypted: Record<string, string> = {};

  for (const key of CREDENTIAL_KEYS) {
    const value = config[key];
    if (value && !String(value).startsWith('plain:')) {
      try {
        decrypted[key] = safeStorage.decryptString(Buffer.from(value, 'base64'));
        debugLog(`Migration phase 2: decrypted ${key}`);
      } catch (err) {
        debugLog(`Migration phase 2: failed to decrypt ${key}: ${err}`);
      }
    }
  }

  if (Object.keys(decrypted).length === 0) {
    debugLog('Migration phase 2: no credentials to migrate');
    return;
  }

  const tempPath = path.join(philibertPath, CREDENTIAL_TEMP_FILE);
  fs.writeFileSync(tempPath, JSON.stringify(decrypted), { mode: 0o600 });
  debugLog('Migration phase 2: wrote decrypted credentials to temp file');
}

/**
 * Phase 3: Called on normal launch after credential migration restart.
 * Reads plaintext from temp file, deletes it immediately, then re-encrypts.
 */
export function finishCredentialMigration(): void {
  const tempPath = path.join(app.getPath('userData'), CREDENTIAL_TEMP_FILE);

  if (!fs.existsSync(tempPath)) return;

  debugLog('Migration phase 3: completing credential migration');

  // Read into memory and delete from disk immediately
  const raw = fs.readFileSync(tempPath, 'utf8');
  try { fs.unlinkSync(tempPath); } catch {
    try { fs.writeFileSync(tempPath, ''); fs.unlinkSync(tempPath); } catch {
      debugLog('Migration phase 3: WARNING — failed to delete temp credential file');
    }
  }

  const decrypted: Record<string, string> = JSON.parse(raw);
  const configPath = path.join(app.getPath('userData'), 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  for (const [key, plaintext] of Object.entries(decrypted)) {
    if (safeStorage.isEncryptionAvailable()) {
      config[key] = safeStorage.encryptString(plaintext).toString('base64');
      debugLog(`Migration phase 3: re-encrypted ${key} with new key`);
    } else {
      config[key] = `plain:${plaintext}`;
      debugLog(`Migration phase 3: stored ${key} as plaintext (no encryption available)`);
    }
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  debugLog('Migration phase 3: credential migration complete');
}

function cleanupOldUpdaterCache(): void {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return;

  const cachePath = path.join(process.env.LOCALAPPDATA, `${OLD_APP_NAME}-updater`);
  if (fs.existsSync(cachePath)) {
    try {
      fs.rmSync(cachePath, { recursive: true, force: true });
      debugLog(`Migration: removed old updater cache at ${cachePath}`);
    } catch (err) {
      debugLog(`Migration: failed to remove updater cache (non-critical): ${err}`);
    }
  }
}
