/**
 * Tests for Auth IPC handlers.
 *
 * Uses real ConfigService with mocked external boundaries:
 * - electron safeStorage (OS keychain)
 * - electron-store (filesystem persistence)
 * - electron dialog (UI prompts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to ensure mocks are available before vi.mock is called
const { mockIpcMainHandle, mockIpcMain, mockSafeStorage, mockDialog, mockStoreData } = vi.hoisted(() => {
  const mockIpcMainHandle = vi.fn();
  const storeData: Record<string, unknown> = {};

  return {
    mockIpcMainHandle,
    mockIpcMain: {
      handle: mockIpcMainHandle,
      on: vi.fn(),
      removeHandler: vi.fn(),
      removeAllListeners: vi.fn(),
    },
    mockSafeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
      decryptString: vi.fn((buffer: Buffer) => {
        const str = buffer.toString();
        if (str.startsWith('encrypted:')) return str.slice('encrypted:'.length);
        throw new Error('decryption failed');
      }),
    },
    mockDialog: {
      showMessageBox: vi.fn(),
    },
    mockStoreData: storeData,
  };
});

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
  BrowserWindow: vi.fn(),
  safeStorage: mockSafeStorage,
  dialog: mockDialog,
}));

vi.mock('electron-store', () => ({
  default: class MockStore {
    private data: Record<string, unknown>;
    constructor(opts?: { defaults?: Record<string, unknown> }) {
      // Shallow-copy defaults into the shared store data
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

vi.mock('../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogLevel: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('../../utils/resourcePaths', () => ({
  getClaudeConfigDir: vi.fn(() => '/tmp/test-claude-config'),
}));

const mockAuthService = {
  startOAuthFlow: vi.fn(),
  completeOAuthFlow: vi.fn(),
  openAuthUrl: vi.fn(),
  cleanupOAuthFlow: vi.fn(),
};

const mockMainWindow = {
  webContents: { send: vi.fn() },
  isDestroyed: vi.fn().mockReturnValue(false),
};

const mockGetMainWindow = vi.fn(() => mockMainWindow);

// Import after mocks
import { IPC_CHANNELS, AuthStatus } from '../../../shared/types';
import { AuthenticationError } from '../../errors';
import ConfigService from '../../services/ConfigService';
import { setupAuthHandlers } from '../auth';

describe('Auth IPC handlers', () => {
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  let configService: ConfigService;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Clear store data between tests
    for (const k of Object.keys(mockStoreData)) delete mockStoreData[k];

    // Restore safeStorage defaults (clearAllMocks only clears history, not implementations)
    mockSafeStorage.isEncryptionAvailable.mockImplementation(() => true);
    mockSafeStorage.encryptString.mockImplementation((value: string) => Buffer.from(`encrypted:${value}`));
    mockSafeStorage.decryptString.mockImplementation((buffer: Buffer) => {
      const str = buffer.toString();
      if (str.startsWith('encrypted:')) return str.slice('encrypted:'.length);
      throw new Error('decryption failed');
    });

    handlers = new Map();
    mockIpcMainHandle.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    });

    // Default mock implementations
    mockAuthService.startOAuthFlow.mockResolvedValue({ authUrl: 'https://auth.example.com/oauth' });
    mockAuthService.completeOAuthFlow.mockResolvedValue({ success: true, token: 'sk-ant-oat01-test-token-for-auth-tests' });
    mockAuthService.openAuthUrl.mockReturnValue(undefined);
    mockAuthService.cleanupOAuthFlow.mockReturnValue(undefined);

    // Real ConfigService with mocked electron-store and safeStorage
    configService = new ConfigService();
    await configService.ensureInitialized();

    setupAuthHandlers(
      mockAuthService as any,
      configService,
      mockGetMainWindow as any
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Handler Registration
  // ===========================================================================
  describe('handler registration', () => {
    it('should register all auth handlers', () => {
      expect(handlers.has(IPC_CHANNELS.AUTH_GET_STATUS)).toBe(true);
      expect(handlers.has(IPC_CHANNELS.AUTH_START_OAUTH)).toBe(true);
      expect(handlers.has(IPC_CHANNELS.AUTH_COMPLETE_OAUTH)).toBe(true);
      expect(handlers.has(IPC_CHANNELS.AUTH_LOGOUT)).toBe(true);
    });
  });

  // ===========================================================================
  // AUTH_GET_STATUS
  // ===========================================================================
  describe('AUTH_GET_STATUS handler', () => {
    let handler: (...args: unknown[]) => unknown;

    beforeEach(() => {
      handler = handlers.get(IPC_CHANNELS.AUTH_GET_STATUS)!;
    });

    it('should return OAuth authenticated status when oauthToken is stored', async () => {
      await configService.setOAuthToken('sk-ant-oat01-stored-token');

      const result = await handler({});

      expect(result).toEqual({
        isAuthenticated: true,
        method: 'oauth',
        displayName: 'Claude Pro/Max Account',
      });
    });

    it('should return API key authenticated status when apiKey is stored', async () => {
      await configService.setApiKey('sk-ant-api03-some-api-key-long-enough-to-pass-min-length');

      const result = await handler({});

      expect(result).toEqual({
        isAuthenticated: true,
        method: 'api-key',
        displayName: 'API Key',
      });
    });

    it('should prefer OAuth over API key if both are present', async () => {
      await configService.setOAuthToken('sk-ant-oat01-token');
      await configService.setApiKey('sk-ant-api03-some-api-key-long-enough-to-pass-min-length');

      const result = await handler({}) as AuthStatus;

      expect(result.method).toBe('oauth');
      expect(result.isAuthenticated).toBe(true);
    });

    it('should return not authenticated when no credentials exist', async () => {
      const result = await handler({});

      expect(result).toEqual({
        isAuthenticated: false,
        method: 'none',
      });
    });

    it('should return not authenticated when stored token cannot be decrypted', async () => {
      // Store a token, then break decryption
      await configService.setOAuthToken('sk-ant-oat01-token');
      mockSafeStorage.decryptString.mockImplementation(() => { throw new Error('keychain reset'); });

      const result = await handler({}) as AuthStatus;

      expect(result.isAuthenticated).toBe(false);
    });

    it('should throw when auth service is not initialized', async () => {
      handlers.clear();
      setupAuthHandlers(null as any, configService, mockGetMainWindow as any);
      const nullHandler = handlers.get(IPC_CHANNELS.AUTH_GET_STATUS)!;

      await expect(nullHandler({})).rejects.toThrow(AuthenticationError);
    });

    it('should throw when config service is not initialized', async () => {
      handlers.clear();
      setupAuthHandlers(mockAuthService as any, null as any, mockGetMainWindow as any);
      const nullHandler = handlers.get(IPC_CHANNELS.AUTH_GET_STATUS)!;

      await expect(nullHandler({})).rejects.toThrow(AuthenticationError);
    });
  });

  // ===========================================================================
  // AUTH_START_OAUTH
  // ===========================================================================
  describe('AUTH_START_OAUTH handler', () => {
    let handler: (...args: unknown[]) => unknown;

    beforeEach(() => {
      handler = handlers.get(IPC_CHANNELS.AUTH_START_OAUTH)!;
    });

    it('should start OAuth flow and return auth URL', async () => {
      const result = await handler({});

      expect(mockAuthService.startOAuthFlow).toHaveBeenCalled();
      expect(mockAuthService.openAuthUrl).toHaveBeenCalledWith('https://auth.example.com/oauth');
      expect(result).toEqual({ authUrl: 'https://auth.example.com/oauth' });
    });

    it('should not open URL if authUrl is empty', async () => {
      mockAuthService.startOAuthFlow.mockResolvedValue({ authUrl: '' });

      const result = await handler({});

      expect(mockAuthService.openAuthUrl).not.toHaveBeenCalled();
      expect(result).toEqual({ authUrl: '' });
    });

    it('should return error object when OAuth flow fails', async () => {
      mockAuthService.startOAuthFlow.mockRejectedValue(new Error('CLI not found'));

      const result = await handler({});

      expect(result).toEqual({
        authUrl: '',
        error: expect.stringContaining('CLI not found'),
      });
    });

    it('should return error when startOAuthFlow returns null', async () => {
      mockAuthService.startOAuthFlow.mockResolvedValue(null);

      const result = await handler({});

      expect(result).toEqual({
        authUrl: '',
        error: expect.stringContaining('OAuth flow initialization returned no result'),
      });
    });
  });

  // ===========================================================================
  // AUTH_COMPLETE_OAUTH
  // ===========================================================================
  describe('AUTH_COMPLETE_OAUTH handler', () => {
    let handler: (...args: unknown[]) => unknown;

    beforeEach(() => {
      handler = handlers.get(IPC_CHANNELS.AUTH_COMPLETE_OAUTH)!;
    });

    it('should complete OAuth flow, store token, and verify round-trip', async () => {
      const result = await handler({}, 'valid_oauth_code_12345');

      expect(mockAuthService.completeOAuthFlow).toHaveBeenCalledWith('valid_oauth_code_12345');
      // Token should actually be stored in the real ConfigService
      const storedToken = await configService.getOAuthToken();
      expect(storedToken).toBe('sk-ant-oat01-test-token-for-auth-tests');
      expect(result).toEqual({ success: true });
    });

    it('should reject tokens that do not start with sk-ant-', async () => {
      mockAuthService.completeOAuthFlow.mockResolvedValue({ success: true, token: 'bad-prefix-token' });

      const result = await handler({}, 'valid_oauth_code_12345');

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('Invalid token format'),
      });
    });

    it('should detect storage round-trip failure', async () => {
      // setOAuthToken only encrypts (no decrypt). The round-trip getOAuthToken
      // is the first and only decrypt call — make it throw.
      mockSafeStorage.decryptString.mockImplementation(() => {
        throw new Error('keychain broken');
      });

      const result = await handler({}, 'valid_oauth_code_12345');

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('Failed to verify stored token'),
      });
    });

    it('should notify renderer of config change on success', async () => {
      await handler({}, 'valid_code');

      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPC_CHANNELS.CONFIG_CHANGED,
        { oauthToken: 'sk-ant-oat01-test-token-for-auth-tests', authMethod: 'oauth' }
      );
    });

    it('should store full credentials JSON when available', async () => {
      const credsJson = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-test', refreshToken: 'rt-123' } });
      mockAuthService.completeOAuthFlow.mockResolvedValue({
        success: true,
        token: 'sk-ant-oat01-test-token-for-auth-tests',
        credentialsJson: credsJson,
      });

      await handler({}, 'valid_code_12345');

      const storedCreds = await configService.getOAuthCredentials();
      expect(storedCreds).toBe(credsJson);
    });

    it('should return error for invalid code format (too short)', async () => {
      const result = await handler({}, 'abc');

      expect(mockAuthService.completeOAuthFlow).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('Invalid code length'),
      });
    });

    it('should return error for empty code', async () => {
      const result = await handler({}, '');

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('Please enter the code'),
      });
    });

    it('should trim whitespace from code', async () => {
      await handler({}, '  valid_oauth_code_12345  ');

      expect(mockAuthService.completeOAuthFlow).toHaveBeenCalledWith('valid_oauth_code_12345');
    });

    it('should return error when OAuth completion fails', async () => {
      mockAuthService.completeOAuthFlow.mockResolvedValue({
        success: false,
        error: 'Invalid code',
      });

      const result = await handler({}, 'invalid_code_12345');

      expect(result).toEqual({
        success: false,
        error: 'Invalid code',
      });
    });

    it('should return error when completeOAuthFlow returns null', async () => {
      mockAuthService.completeOAuthFlow.mockResolvedValue(null);

      const result = await handler({}, 'some_code_12345');

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('OAuth completion returned no result'),
      });
    });

    it('should handle OAuth success without token', async () => {
      mockAuthService.completeOAuthFlow.mockResolvedValue({
        success: true,
        token: '',
      });

      const result = await handler({}, 'valid_code_12345');

      expect(result).toEqual({
        success: false,
        error: 'OAuth completion failed',
      });
    });
  });

  // ===========================================================================
  // AUTH_LOGOUT
  // ===========================================================================
  describe('AUTH_LOGOUT handler', () => {
    let handler: (...args: unknown[]) => unknown;

    beforeEach(async () => {
      handler = handlers.get(IPC_CHANNELS.AUTH_LOGOUT)!;
      // Store credentials so logout has something to clear
      await configService.setOAuthToken('sk-ant-oat01-to-be-cleared');
    });

    it('should clear all credentials from real ConfigService', async () => {
      await handler({});

      const token = await configService.getOAuthToken();
      expect(token).toBe('');
      const key = await configService.getApiKey();
      expect(key).toBe('');
    });

    it('should cleanup pending OAuth flows', async () => {
      await handler({});

      expect(mockAuthService.cleanupOAuthFlow).toHaveBeenCalled();
    });

    it('should notify renderer of config change', async () => {
      await handler({});

      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPC_CHANNELS.CONFIG_CHANGED,
        { oauthToken: '', apiKey: '', authMethod: 'none' }
      );
    });

    it('should update authMethod to none after logout', async () => {
      await handler({});

      const config = await configService.getConfig();
      expect(config.authMethod).toBe('none');
    });

    it('should throw when auth service is not initialized', async () => {
      handlers.clear();
      setupAuthHandlers(null as any, configService, mockGetMainWindow as any);
      const nullHandler = handlers.get(IPC_CHANNELS.AUTH_LOGOUT)!;

      await expect(nullHandler({})).rejects.toThrow(AuthenticationError);
    });

    it('should throw when config service is not initialized', async () => {
      handlers.clear();
      setupAuthHandlers(mockAuthService as any, null as any, mockGetMainWindow as any);
      const nullHandler = handlers.get(IPC_CHANNELS.AUTH_LOGOUT)!;

      await expect(nullHandler({})).rejects.toThrow(AuthenticationError);
    });
  });

  // ===========================================================================
  // Window Notification Edge Cases
  // ===========================================================================
  describe('window notification edge cases', () => {
    it('should handle null main window gracefully', async () => {
      mockGetMainWindow.mockReturnValue(null as any);
      const handler = handlers.get(IPC_CHANNELS.AUTH_COMPLETE_OAUTH)!;

      const result = await handler({}, 'valid_code_12345') as { success: boolean; error?: string };

      expect(result.success).toBe(true);
    });

    it('should handle destroyed window gracefully', async () => {
      mockMainWindow.isDestroyed.mockReturnValue(true);
      const handler = handlers.get(IPC_CHANNELS.AUTH_LOGOUT)!;

      await expect(handler({})).resolves.toBeUndefined();
    });
  });
});
