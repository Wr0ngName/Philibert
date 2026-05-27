import fs from 'node:fs';
import path from 'node:path';

import { app, safeStorage } from 'electron';

import { debugLog } from './debugLog';
import logger from './logger';

// All possible old app names, ordered by likelihood.
// "ClineGUI" was productName for v0.1.22–v0.11.7 (vast majority of installs).
// "Cline GUI" (with space) was productName for v0.1.0–v0.1.21.
// "cline-gui" was the package.json name field (possible on some Electron versions/platforms).
const OLD_APP_NAMES = ['ClineGUI', 'Cline GUI', 'cline-gui'] as const;
const NEW_APP_NAME = 'Philibert';

const CREDENTIAL_KEYS = ['encryptedApiKey', 'encryptedOAuthToken'] as const;
const CREDENTIAL_TEMP_FILE = '.credential-migration.json';

interface OldAppInfo {
  path: string;
  name: string;
}

function findOldUserDataPath(): OldAppInfo | null {
  const parentDir = path.dirname(app.getPath('userData'));
  for (const name of OLD_APP_NAMES) {
    const candidate = path.join(parentDir, name);
    if (fs.existsSync(candidate)) {
      debugLog(`Migration: found old data directory "${name}" at ${candidate}`);
      return { path: candidate, name };
    }
  }
  return null;
}

function getPhilibertUserDataPath(): string {
  return path.join(path.dirname(app.getPath('userData')), NEW_APP_NAME);
}

function wipeTempFile(tempPath: string): void {
  try {
    fs.unlinkSync(tempPath);
  } catch {
    // Can't delete — at least wipe the content so plaintext doesn't stay on disk
    try { fs.writeFileSync(tempPath, '', { mode: 0o000 }); } catch { /* exhausted */ }
    debugLog(`Migration: CRITICAL — could not delete temp credential file at ${tempPath}`);
  }
}

interface MigrationResult {
  needsCredentialRestart: boolean;
  oldAppName?: string;
}

/**
 * Try to decrypt a credential blob under the current app name's safeStorage key.
 * Returns true if decryption succeeds (credentials are portable), false otherwise.
 */
function canDecryptCredentials(config: Record<string, unknown>): boolean {
  if (!safeStorage.isEncryptionAvailable()) {
    debugLog('Migration: safeStorage not available, cannot test decryption');
    return false;
  }

  for (const key of CREDENTIAL_KEYS) {
    const value = config[key];
    if (value && typeof value === 'string' && !value.startsWith('plain:')) {
      try {
        safeStorage.decryptString(Buffer.from(value, 'base64'));
        debugLog(`Migration: test decryption of ${key} succeeded — no re-key needed`);
        return true;
      } catch {
        debugLog(`Migration: test decryption of ${key} failed — re-key required`);
        return false;
      }
    }
  }
  return false;
}

/**
 * Atomically write JSON to a file: write to a temp file in the same directory,
 * then rename.  On crash, either the old file or the new file survives intact.
 */
function atomicWriteJson(filePath: string, data: unknown): void {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

/**
 * Clear undecryptable credentials from config so the user can re-authenticate.
 */
function clearBrokenCredentials(configPath: string, reason: string): void {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    for (const key of CREDENTIAL_KEYS) {
      delete config[key];
    }
    config['authMethod'] = 'none';
    atomicWriteJson(configPath, config);
    logger.warn('Migration: cleared broken credentials', { reason });
    debugLog(`Migration: cleared broken credentials (${reason})`);
  } catch (err) {
    logger.error('Migration: failed to clear broken credentials', { error: String(err) });
    debugLog(`Migration: failed to clear broken credentials: ${err}`);
  }
}

/**
 * Handle credentials that can't be decrypted under the current app name.
 * Electron's safeStorage encryption key is app-scoped on all platforms
 * (Chromium os_crypt key in Local State on Windows, Keychain on macOS,
 * libsecret on Linux), so restarting with the old app name can recover them.
 *
 * Uses an attempt counter to prevent infinite restart loops — after
 * MAX_MIGRATION_ATTEMPTS failures, clears credentials so the user can
 * re-authenticate cleanly.
 */
function handleUndecryptableCredentials(
  configPath: string,
  oldAppName: string,
  newPath: string,
): MigrationResult {
  const attempts = getMigrationAttempts(newPath);
  if (attempts >= MAX_MIGRATION_ATTEMPTS) {
    logger.warn('Migration: exhausted re-key attempts, clearing broken credentials', {
      attempts: MAX_MIGRATION_ATTEMPTS, oldAppName,
    });
    debugLog(`Migration: exhausted ${MAX_MIGRATION_ATTEMPTS} re-key attempts, clearing broken credentials`);
    clearBrokenCredentials(configPath, `exhausted ${MAX_MIGRATION_ATTEMPTS} attempts`);
    clearMigrationAttempts(newPath);
    cleanupOldAppDirectory();
    return { needsCredentialRestart: false };
  }

  incrementMigrationAttempts(newPath);
  logger.info('Migration: scheduling credential re-key restart', {
    oldAppName, attempt: attempts + 1, maxAttempts: MAX_MIGRATION_ATTEMPTS,
  });
  debugLog(`Migration: scheduling re-key restart with "${oldAppName}" (attempt ${attempts + 1}/${MAX_MIGRATION_ATTEMPTS})`);
  return { needsCredentialRestart: true, oldAppName };
}

/**
 * Phase 1: Migrate user data from old "Cline GUI" app to new "Philibert" app.
 * Copies config.json and conversations, removes old directory, cleans up updater cache.
 *
 * Returns { needsCredentialRestart: true } when encrypted credentials exist that
 * can't be decrypted under the new app name. Electron's safeStorage encryption
 * key is app-scoped on all platforms (Chromium os_crypt in Local State on
 * Windows, Keychain on macOS, libsecret on Linux), so a restart with the old
 * app name is needed to decrypt and re-key them.
 *
 * All restart paths go through handleUndecryptableCredentials() which uses an
 * attempt counter to prevent infinite loops.
 */
export function migrateFromOldApp(): MigrationResult {
  const oldApp = findOldUserDataPath();
  const newPath = app.getPath('userData');

  if (!oldApp) {
    logger.info('Migration: no old app data found');
    debugLog('Migration: no old app data found');
    cleanupOldUpdaterCaches();

    const recoveryResult = recoverStuckCredentials(newPath);
    if (recoveryResult) return recoveryResult;

    return { needsCredentialRestart: false };
  }

  const oldPath = oldApp.path;

  const newConfig = path.join(newPath, 'config.json');
  if (fs.existsSync(newConfig)) {
    logger.info('Migration: Philibert config already exists, checking credentials', {
      oldAppName: oldApp.name, oldPath,
    });
    debugLog('Migration: Philibert config already exists, skipping data copy');
    cleanupOldUpdaterCaches();

    try {
      const config = JSON.parse(fs.readFileSync(newConfig, 'utf8'));
      const hasEncryptedCredentials = CREDENTIAL_KEYS.some(
        (key) => config[key] && typeof config[key] === 'string' && !String(config[key]).startsWith('plain:')
      );
      if (hasEncryptedCredentials) {
        if (!safeStorage.isEncryptionAvailable()) {
          debugLog('Migration: safeStorage not available, skipping credential re-key check');
          logger.info('Migration: safeStorage temporarily unavailable, deferring credential check');
        } else if (!canDecryptCredentials(config)) {
          logger.warn('Migration: credentials need re-keying', { oldAppName: oldApp.name });
          return handleUndecryptableCredentials(newConfig, oldApp.name, newPath);
        }
      }
      logger.info('Migration: credentials OK (decryptable or none present)');
    } catch (err) {
      logger.error('Migration: failed to check credentials', { error: String(err) });
      debugLog(`Migration: failed to check credentials in existing config: ${err}`);
    }

    return { needsCredentialRestart: false };
  }

  logger.info('Migration: migrating data from old app', {
    oldAppName: oldApp.name, oldPath, newPath,
  });
  debugLog(`Migration: migrating data from "${oldApp.name}" at ${oldPath} to ${newPath}`);

  fs.mkdirSync(newPath, { recursive: true });

  const oldConfig = path.join(oldPath, 'config.json');
  let hasEncryptedCredentials = false;
  let config: Record<string, unknown> | null = null;

  if (fs.existsSync(oldConfig)) {
    try {
      fs.copyFileSync(oldConfig, newConfig);
      debugLog('Migration: copied config.json');

      config = JSON.parse(fs.readFileSync(newConfig, 'utf8'));
      hasEncryptedCredentials = CREDENTIAL_KEYS.some(
        (key) => config![key] && typeof config![key] === 'string' && !String(config![key]).startsWith('plain:')
      );
    } catch (err) {
      debugLog(`Migration: failed to copy/parse config.json: ${err}`);
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

  cleanupOldUpdaterCaches();

  if (hasEncryptedCredentials && config) {
    if (!safeStorage.isEncryptionAvailable()) {
      debugLog('Migration: safeStorage not available after fresh copy, skipping re-key check');
      logger.info('Migration: safeStorage temporarily unavailable, deferring credential check');
    } else if (!canDecryptCredentials(config)) {
      logger.info('Migration: credentials need re-keying, keeping old directory', {
        oldAppName: oldApp.name,
      });
      debugLog('Migration: keeping old directory for credential re-keying');
      return handleUndecryptableCredentials(newConfig, oldApp.name, newPath);
    }
  }

  try {
    fs.rmSync(oldPath, { recursive: true, force: true });
    debugLog(`Migration: removed old data directory at ${oldPath}`);
  } catch (err) {
    debugLog(`Migration: failed to remove old directory (non-critical): ${err}`);
  }

  logger.info('Migration: phase 1 complete (no re-keying needed)');
  debugLog('Migration: phase 1 complete');
  return { needsCredentialRestart: false };
}

/**
 * Phase 2: Called on restart with --migrate-credentials flag.
 * At this point app.setName() was called with the detected old app name before ready,
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

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    debugLog(`Migration phase 2: failed to read/parse config: ${err}`);
    return;
  }

  const decrypted: Record<string, string> = {};

  for (const key of CREDENTIAL_KEYS) {
    const value = config[key];
    if (value && typeof value === 'string' && !value.startsWith('plain:')) {
      try {
        decrypted[key] = safeStorage.decryptString(Buffer.from(value, 'base64'));
        debugLog(`Migration phase 2: decrypted ${key}`);
      } catch (err) {
        debugLog(`Migration phase 2: failed to decrypt ${key}: ${err}`);
      }
    }
  }

  if (Object.keys(decrypted).length === 0) {
    logger.warn('Migration phase 2: no credentials could be decrypted');
    debugLog('Migration phase 2: no credentials to migrate');
    return;
  }

  const tempPath = path.join(philibertPath, CREDENTIAL_TEMP_FILE);
  fs.writeFileSync(tempPath, JSON.stringify(decrypted), { mode: 0o600 });
  logger.info('Migration phase 2: decrypted credentials written to temp file', {
    keys: Object.keys(decrypted),
  });
  debugLog('Migration phase 2: wrote decrypted credentials to temp file');
}

/**
 * Phase 3: Called on normal launch after credential migration restart.
 * Reads plaintext from temp file, deletes it immediately, then re-encrypts.
 * The temp file is ALWAYS deleted regardless of whether re-encryption succeeds.
 */
export function finishCredentialMigration(): void {
  const tempPath = path.join(app.getPath('userData'), CREDENTIAL_TEMP_FILE);

  if (!fs.existsSync(tempPath)) return;

  debugLog('Migration phase 3: completing credential migration');

  // Read and wipe temp file — always delete, even if read or parse fails
  let decrypted: Record<string, string> | null = null;
  try {
    const raw = fs.readFileSync(tempPath, 'utf8');
    decrypted = JSON.parse(raw);
  } catch (err) {
    debugLog(`Migration phase 3: failed to read/parse temp file: ${err}`);
  } finally {
    wipeTempFile(tempPath);
  }

  if (!decrypted || Object.keys(decrypted).length === 0) return;

  let config: Record<string, unknown>;
  try {
    const configPath = path.join(app.getPath('userData'), 'config.json');
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    debugLog(`Migration phase 3: failed to read config.json: ${err}`);
    return;
  }

  for (const [key, plaintext] of Object.entries(decrypted)) {
    if (safeStorage.isEncryptionAvailable()) {
      config[key] = safeStorage.encryptString(plaintext).toString('base64');
      debugLog(`Migration phase 3: re-encrypted ${key} with new key`);
    } else {
      config[key] = `plain:${plaintext}`;
      debugLog(`Migration phase 3: stored ${key} as plaintext (no encryption available)`);
    }
  }

  const configPath = path.join(app.getPath('userData'), 'config.json');
  atomicWriteJson(configPath, config);
  clearMigrationAttempts(app.getPath('userData'));
  cleanupOldAppDirectory();

  logger.info('Migration phase 3: credential migration complete');
  debugLog('Migration phase 3: credential migration complete');
}

const MIGRATION_ATTEMPT_FILE = '.credential-migration-attempts';
const MAX_MIGRATION_ATTEMPTS = 3;

/**
 * Recovery helper: detect credentials that are stuck encrypted with the
 * old app's safeStorage key.  This covers the case where phase 1 completed
 * (config copied, old dir deleted) but the phase-2 restart never happened.
 */
function recoverStuckCredentials(newPath: string): MigrationResult | null {
  const configPath = path.join(newPath, 'config.json');
  if (!fs.existsSync(configPath)) return null;

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const hasEncryptedCredentials = CREDENTIAL_KEYS.some(
      (key) => config[key] && typeof config[key] === 'string' && !String(config[key]).startsWith('plain:')
    );
    if (!hasEncryptedCredentials) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      debugLog('Migration recovery: safeStorage not available, skipping (cannot test decryption)');
      return null;
    }
    if (canDecryptCredentials(config)) {
      clearMigrationAttempts(newPath);
      return null;
    }

    const attempts = getMigrationAttempts(newPath);
    const nameIndex = attempts % OLD_APP_NAMES.length;
    const oldAppName = OLD_APP_NAMES[nameIndex];
    debugLog(`Migration recovery: trying old app name "${oldAppName}" (attempt ${attempts + 1})`);
    return handleUndecryptableCredentials(configPath, oldAppName, newPath);
  } catch (err) {
    debugLog(`Migration recovery: failed to read config: ${err}`);
  }
  return null;
}

function getMigrationAttempts(newPath: string): number {
  try {
    const attemptFile = path.join(newPath, MIGRATION_ATTEMPT_FILE);
    if (fs.existsSync(attemptFile)) {
      return parseInt(fs.readFileSync(attemptFile, 'utf8').trim(), 10) || 0;
    }
  } catch { /* ignore */ }
  return 0;
}

function incrementMigrationAttempts(newPath: string): void {
  try {
    const attemptFile = path.join(newPath, MIGRATION_ATTEMPT_FILE);
    const current = getMigrationAttempts(newPath);
    fs.writeFileSync(attemptFile, String(current + 1));
  } catch { /* ignore */ }
}

function clearMigrationAttempts(newPath: string): void {
  try {
    const attemptFile = path.join(newPath, MIGRATION_ATTEMPT_FILE);
    if (fs.existsSync(attemptFile)) fs.unlinkSync(attemptFile);
  } catch { /* ignore */ }
}

function cleanupOldAppDirectory(): void {
  const parentDir = path.dirname(app.getPath('userData'));
  for (const name of OLD_APP_NAMES) {
    const candidate = path.join(parentDir, name);
    if (fs.existsSync(candidate)) {
      try {
        fs.rmSync(candidate, { recursive: true, force: true });
        debugLog(`Migration: removed old app directory at ${candidate}`);
      } catch (err) {
        debugLog(`Migration: failed to remove old directory ${candidate} (non-critical): ${err}`);
      }
    }
  }
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
