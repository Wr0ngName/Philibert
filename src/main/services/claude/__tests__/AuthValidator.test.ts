/**
 * Tests for AuthValidator.
 *
 * Uses real ConfigService with mocked external boundaries:
 * - electron safeStorage (OS keychain)
 * - electron-store (filesystem persistence)
 * - fs (filesystem operations for credentials file)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSafeStorage, mockStoreData, mockFsExistsSync, mockFsMkdirSync, mockFsWriteFileSync } = vi.hoisted(() => {
  const storeData: Record<string, unknown> = {};

  return {
    mockSafeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
      decryptString: vi.fn((buffer: Buffer) => {
        const str = buffer.toString();
        if (str.startsWith('encrypted:')) return str.slice('encrypted:'.length);
        throw new Error('decryption failed');
      }),
    },
    mockStoreData: storeData,
    mockFsExistsSync: vi.fn(() => false),
    mockFsMkdirSync: vi.fn(),
    mockFsWriteFileSync: vi.fn(),
  };
});

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() },
  BrowserWindow: vi.fn(),
  safeStorage: mockSafeStorage,
  dialog: { showMessageBox: vi.fn() },
}));

vi.mock('electron-store', () => ({
  default: class MockStore {
    private data: Record<string, unknown>;
    constructor(opts?: { defaults?: Record<string, unknown> }) {
      Object.assign(mockStoreData, opts?.defaults || {});
      this.data = mockStoreData;
    }
    get(key: string, defaultValue?: unknown) {
      return key in this.data ? this.data[key] : defaultValue;
    }
    set(key: string, value: unknown) { this.data[key] = value; }
    delete(key: string) { delete this.data[key]; }
    clear() { for (const k of Object.keys(this.data)) delete this.data[k]; }
    get store() { return { ...this.data }; }
  },
}));

vi.mock('../../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogLevel: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: mockFsExistsSync,
  mkdirSync: mockFsMkdirSync,
  writeFileSync: mockFsWriteFileSync,
  unlinkSync: vi.fn(),
}));

vi.mock('../../../utils/resourcePaths', () => ({
  getClaudeConfigDir: vi.fn(() => '/tmp/test-claude-config'),
}));

import ConfigService from '../../ConfigService';
import { AuthValidator } from '../AuthValidator';

describe('AuthValidator', () => {
  let configService: ConfigService;
  let validator: AuthValidator;

  beforeEach(async () => {
    vi.clearAllMocks();
    for (const k of Object.keys(mockStoreData)) delete mockStoreData[k];

    mockSafeStorage.isEncryptionAvailable.mockImplementation(() => true);
    mockSafeStorage.encryptString.mockImplementation((value: string) => Buffer.from(`encrypted:${value}`));
    mockSafeStorage.decryptString.mockImplementation((buffer: Buffer) => {
      const str = buffer.toString();
      if (str.startsWith('encrypted:')) return str.slice('encrypted:'.length);
      throw new Error('decryption failed');
    });

    configService = new ConfigService();
    await configService.ensureInitialized();
    validator = new AuthValidator(configService);
  });

  // ===========================================================================
  // hasAuth
  // ===========================================================================
  describe('hasAuth', () => {
    it('should return true when OAuth token is stored', async () => {
      await configService.setOAuthToken('sk-ant-oat01-valid-token');
      expect(await validator.hasAuth()).toBe(true);
    });

    it('should return true when API key is stored', async () => {
      await configService.setApiKey('sk-ant-api03-valid-key-that-is-long-enough');
      expect(await validator.hasAuth()).toBe(true);
    });

    it('should return false when no credentials exist', async () => {
      expect(await validator.hasAuth()).toBe(false);
    });
  });

  // ===========================================================================
  // validateOAuthToken
  // ===========================================================================
  describe('validateOAuthToken', () => {
    it('should accept valid sk-ant- prefixed tokens', () => {
      expect(validator.validateOAuthToken('sk-ant-oat01-abc').valid).toBe(true);
    });

    it('should reject empty token', () => {
      const result = validator.validateOAuthToken('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should reject token without sk-ant- prefix', () => {
      const result = validator.validateOAuthToken('bad-prefix-token');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('sk-ant-');
    });
  });

  // ===========================================================================
  // validateApiKey
  // ===========================================================================
  describe('validateApiKey', () => {
    it('should accept valid sk-ant-api03 key', () => {
      expect(validator.validateApiKey('sk-ant-api03-long-enough-key-string-here').valid).toBe(true);
    });

    it('should reject empty key', () => {
      expect(validator.validateApiKey('').valid).toBe(false);
    });

    it('should reject key without sk- prefix', () => {
      const result = validator.validateApiKey('bad-key-format');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('sk-');
    });

    it('should reject key that is too short', () => {
      const result = validator.validateApiKey('sk-abc');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('short');
    });
  });

  // ===========================================================================
  // setupAuthEnv — CLAUDE_CONFIG_DIR vs CLAUDE_CODE_OAUTH_TOKEN
  // ===========================================================================
  describe('setupAuthEnv', () => {
    it('should prefer CLAUDE_CONFIG_DIR when full credentials are available', async () => {
      const credsJson = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-test', refreshToken: 'rt-123' } });
      await configService.setOAuthToken('sk-ant-oat01-test');
      await configService.setOAuthCredentials(credsJson);

      const env = await validator.setupAuthEnv();

      expect(env['CLAUDE_CONFIG_DIR']).toBe('/tmp/test-claude-config');
      expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
      expect(mockFsMkdirSync).toHaveBeenCalledWith('/tmp/test-claude-config', { recursive: true });
      expect(mockFsWriteFileSync).toHaveBeenCalledWith(
        '/tmp/test-claude-config/.credentials.json',
        credsJson,
        'utf8'
      );
    });

    it('should fall back to CLAUDE_CODE_OAUTH_TOKEN when no full credentials exist', async () => {
      await configService.setOAuthToken('sk-ant-oat01-valid-token-that-is-long-enough');

      const env = await validator.setupAuthEnv();

      expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-ant-oat01-valid-token-that-is-long-enough');
      expect(env['CLAUDE_CONFIG_DIR']).toBeUndefined();
    });

    it('should fall back to CLAUDE_CODE_OAUTH_TOKEN when credentials file write fails', async () => {
      const credsJson = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-test' } });
      await configService.setOAuthToken('sk-ant-oat01-valid-token-that-is-long-enough');
      await configService.setOAuthCredentials(credsJson);
      mockFsWriteFileSync.mockImplementation(() => { throw new Error('EACCES: permission denied'); });

      const env = await validator.setupAuthEnv();

      expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-ant-oat01-valid-token-that-is-long-enough');
      expect(env['CLAUDE_CONFIG_DIR']).toBeUndefined();
    });

    it('should use ANTHROPIC_API_KEY when only API key is available', async () => {
      await configService.setApiKey('sk-ant-api03-valid-key-that-is-long-enough-to-pass');

      const env = await validator.setupAuthEnv();

      expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-api03-valid-key-that-is-long-enough-to-pass');
      expect(env['CLAUDE_CONFIG_DIR']).toBeUndefined();
      expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    });

    it('should return empty env when no credentials exist', async () => {
      const env = await validator.setupAuthEnv();

      expect(Object.keys(env)).toHaveLength(0);
    });

    it('should throw when OAuth token format is invalid', async () => {
      await configService.setOAuthToken('bad-prefix-token');

      await expect(validator.setupAuthEnv()).rejects.toThrow('Invalid OAuth token');
    });

    it('should throw when API key format is invalid', async () => {
      await configService.setApiKey('bad-key');

      await expect(validator.setupAuthEnv()).rejects.toThrow('Invalid API key');
    });
  });
});
