import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock electron
const mockGetPath = vi.fn();
const mockIsEncryptionAvailable = vi.fn();
const mockDecryptString = vi.fn();
const mockEncryptString = vi.fn();

vi.mock('electron', () => ({
  app: {
    getPath: (...args: unknown[]) => mockGetPath(...args),
  },
  safeStorage: {
    isEncryptionAvailable: () => mockIsEncryptionAvailable(),
    decryptString: (...args: unknown[]) => mockDecryptString(...args),
    encryptString: (...args: unknown[]) => mockEncryptString(...args),
  },
}));

vi.mock('../debugLog', () => ({
  debugLog: vi.fn(),
}));

vi.mock('../logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { migrateFromOldApp, finishCredentialMigration } from '../migration';

const FAKE_APPDATA = '/tmp/test-appdata';
const OLD_DIR = path.join(FAKE_APPDATA, 'ClineGUI');
const NEW_DIR = path.join(FAKE_APPDATA, 'Philibert');

function setupDirs(): void {
  fs.mkdirSync(OLD_DIR, { recursive: true });
  fs.mkdirSync(NEW_DIR, { recursive: true });
}

function writeConfig(dir: string, config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

function readConfig(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
}

describe('migrateFromOldApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPath.mockImplementation((name: string) => {
      if (name === 'userData') return NEW_DIR;
      return FAKE_APPDATA;
    });
    // Clean up test dirs
    for (const dir of [OLD_DIR, NEW_DIR]) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    for (const dir of [OLD_DIR, NEW_DIR]) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns no restart when no old app exists', () => {
    fs.mkdirSync(NEW_DIR, { recursive: true });
    const result = migrateFromOldApp();
    expect(result.needsCredentialRestart).toBe(false);
  });

  it('copies config and conversations from old app', () => {
    setupDirs();
    writeConfig(OLD_DIR, { foo: 'bar' });
    const convDir = path.join(OLD_DIR, 'conversations');
    fs.mkdirSync(convDir, { recursive: true });
    fs.writeFileSync(path.join(convDir, 'test.json'), '{"id":"test"}');

    mockIsEncryptionAvailable.mockReturnValue(true);

    const result = migrateFromOldApp();
    expect(result.needsCredentialRestart).toBe(false);
    expect(fs.existsSync(path.join(NEW_DIR, 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(NEW_DIR, 'conversations', 'test.json'))).toBe(true);
  });

  it('returns restart needed when credentials cannot be decrypted', () => {
    setupDirs();
    writeConfig(OLD_DIR, { encryptedOAuthToken: 'base64encryptedblob' });

    mockIsEncryptionAvailable.mockReturnValue(true);
    mockDecryptString.mockImplementation(() => { throw new Error('decrypt failed'); });

    const result = migrateFromOldApp();
    expect(result.needsCredentialRestart).toBe(true);
    expect(result.oldAppName).toBe('ClineGUI');
  });

  it('preserves old directory when credentials need re-keying', () => {
    setupDirs();
    writeConfig(OLD_DIR, { encryptedOAuthToken: 'base64encryptedblob' });

    mockIsEncryptionAvailable.mockReturnValue(true);
    mockDecryptString.mockImplementation(() => { throw new Error('decrypt failed'); });

    migrateFromOldApp();
    // Old dir must still exist for phase 2 to read Local State
    expect(fs.existsSync(OLD_DIR)).toBe(true);
  });

  it('stops restart loop after MAX_MIGRATION_ATTEMPTS', () => {
    setupDirs();
    writeConfig(OLD_DIR, { encryptedOAuthToken: 'base64encryptedblob' });

    mockIsEncryptionAvailable.mockReturnValue(true);
    mockDecryptString.mockImplementation(() => { throw new Error('decrypt failed'); });

    // Attempt 1: restart needed
    const result1 = migrateFromOldApp();
    expect(result1.needsCredentialRestart).toBe(true);

    // Attempt 2: restart needed (counter now at 1, increments to 2)
    const result2 = migrateFromOldApp();
    expect(result2.needsCredentialRestart).toBe(true);

    // Attempt 3: counter at 2 = MAX, should clear credentials and stop
    const result3 = migrateFromOldApp();
    expect(result3.needsCredentialRestart).toBe(false);

    // Verify credentials were cleared
    const config = readConfig(NEW_DIR);
    expect(config.encryptedOAuthToken).toBeUndefined();
    expect(config.authMethod).toBe('none');
  });

  it('stops restart loop even when old dir cannot be deleted (Windows scenario)', () => {
    setupDirs();
    writeConfig(OLD_DIR, { encryptedOAuthToken: 'base64encryptedblob' });

    mockIsEncryptionAvailable.mockReturnValue(true);
    mockDecryptString.mockImplementation(() => { throw new Error('decrypt failed'); });

    // Simulate: phase 1 runs, copies config. Old dir persists (locked on Windows).
    // Each launch: old dir exists + new config exists → Path 1 → handleUndecryptableCredentials
    migrateFromOldApp(); // attempt 1
    // Old dir still exists, new config exists — simulates Path 1 on next launch
    expect(fs.existsSync(path.join(NEW_DIR, 'config.json'))).toBe(true);
    expect(fs.existsSync(OLD_DIR)).toBe(true);

    migrateFromOldApp(); // attempt 2 (Path 1: config exists + old dir exists)

    const result3 = migrateFromOldApp(); // attempt 3 → MAX reached → clear
    expect(result3.needsCredentialRestart).toBe(false);

    const config = readConfig(NEW_DIR);
    expect(config.encryptedOAuthToken).toBeUndefined();
  });

  it('does not restart when credentials are decryptable (no re-key needed)', () => {
    setupDirs();
    writeConfig(OLD_DIR, { encryptedOAuthToken: 'base64encryptedblob' });

    mockIsEncryptionAvailable.mockReturnValue(true);
    mockDecryptString.mockReturnValue('decrypted-token');

    const result = migrateFromOldApp();
    expect(result.needsCredentialRestart).toBe(false);
  });

  it('does not restart when no encrypted credentials exist', () => {
    setupDirs();
    writeConfig(OLD_DIR, { authMethod: 'none' });

    const result = migrateFromOldApp();
    expect(result.needsCredentialRestart).toBe(false);
  });

  it('skips recovery when safeStorage is unavailable', () => {
    // No old dir, but config has encrypted credentials that can't be tested
    fs.mkdirSync(NEW_DIR, { recursive: true });
    writeConfig(NEW_DIR, { encryptedOAuthToken: 'base64encryptedblob' });

    mockIsEncryptionAvailable.mockReturnValue(false);

    const result = migrateFromOldApp();
    expect(result.needsCredentialRestart).toBe(false);
    // Credentials should NOT be cleared — safeStorage is just temporarily unavailable
    const config = readConfig(NEW_DIR);
    expect(config.encryptedOAuthToken).toBe('base64encryptedblob');
  });
});

describe('finishCredentialMigration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPath.mockImplementation((name: string) => {
      if (name === 'userData') return NEW_DIR;
      return FAKE_APPDATA;
    });
    for (const dir of [OLD_DIR, NEW_DIR]) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    for (const dir of [OLD_DIR, NEW_DIR]) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-encrypts credentials from temp file and cleans up', () => {
    fs.mkdirSync(NEW_DIR, { recursive: true });
    writeConfig(NEW_DIR, { encryptedOAuthToken: 'old-encrypted-blob' });

    const tempPath = path.join(NEW_DIR, '.credential-migration.json');
    fs.writeFileSync(tempPath, JSON.stringify({ encryptedOAuthToken: 'plaintext-token' }));

    mockIsEncryptionAvailable.mockReturnValue(true);
    mockEncryptString.mockReturnValue(Buffer.from('new-encrypted-blob'));

    finishCredentialMigration();

    // Temp file should be deleted
    expect(fs.existsSync(tempPath)).toBe(false);
    // Credentials should be re-encrypted
    const config = readConfig(NEW_DIR);
    expect(config.encryptedOAuthToken).toBe(Buffer.from('new-encrypted-blob').toString('base64'));
  });

  it('cleans up old app directory after successful re-keying', () => {
    fs.mkdirSync(OLD_DIR, { recursive: true });
    fs.mkdirSync(NEW_DIR, { recursive: true });
    writeConfig(NEW_DIR, { encryptedOAuthToken: 'old-encrypted' });

    const tempPath = path.join(NEW_DIR, '.credential-migration.json');
    fs.writeFileSync(tempPath, JSON.stringify({ encryptedOAuthToken: 'plaintext' }));

    mockIsEncryptionAvailable.mockReturnValue(true);
    mockEncryptString.mockReturnValue(Buffer.from('new-encrypted'));

    finishCredentialMigration();

    // Old directory should be cleaned up
    expect(fs.existsSync(OLD_DIR)).toBe(false);
  });

  it('always deletes temp file even on parse error', () => {
    fs.mkdirSync(NEW_DIR, { recursive: true });
    const tempPath = path.join(NEW_DIR, '.credential-migration.json');
    fs.writeFileSync(tempPath, 'not-valid-json{{{');

    finishCredentialMigration();

    expect(fs.existsSync(tempPath)).toBe(false);
  });
});
