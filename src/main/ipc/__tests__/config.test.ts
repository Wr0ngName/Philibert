/**
 * Comprehensive tests for Config IPC handlers.
 *
 * Tests cover:
 * - CONFIG_GET handler for retrieving configuration
 * - CONFIG_SET handler for updating configuration
 * - Service validation for all handlers
 * - Input validation
 * - Error propagation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to ensure mocks are available before vi.mock is called
const { mockIpcMainHandle, mockIpcMain } = vi.hoisted(() => {
  const mockIpcMainHandle = vi.fn();
  return {
    mockIpcMainHandle,
    mockIpcMain: {
      handle: mockIpcMainHandle,
      on: vi.fn(),
      removeHandler: vi.fn(),
      removeAllListeners: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
  BrowserWindow: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockConfigService = {
  getConfig: vi.fn(),
  setConfig: vi.fn(),
};

const mockMainWindow = {
  webContents: {
    send: vi.fn(),
  },
  isDestroyed: vi.fn().mockReturnValue(false),
};

const mockGetMainWindow = vi.fn(() => mockMainWindow);

// Import after mocks
import { IPC_CHANNELS, AppConfig } from '../../../shared/types';
import { ConfigurationError } from '../../errors';
import { setupConfigIPC } from '../config';

describe('Config IPC handlers', () => {
  let handlers: Map<string, (...args: unknown[]) => unknown>;

  const defaultConfig = {
    apiKey: '',
    oauthToken: '',
    authMethod: 'none' as const,
    workingDirectory: '/home/user/project',
    theme: 'system' as const,
    fontSize: 14,
    autoApproveReads: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();

    // Capture registered handlers
    mockIpcMainHandle.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    });

    // Default mock implementations
    mockConfigService.getConfig.mockResolvedValue({ ...defaultConfig });
    mockConfigService.setConfig.mockResolvedValue(undefined);

    // Register handlers
    setupConfigIPC(mockConfigService as any, mockGetMainWindow as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Handler Registration
  // ===========================================================================
  describe('handler registration', () => {
    it('should register all config handlers', () => {
      expect(handlers.has(IPC_CHANNELS.CONFIG_GET)).toBe(true);
      expect(handlers.has(IPC_CHANNELS.CONFIG_SET)).toBe(true);
    });
  });

  // ===========================================================================
  // CONFIG_GET
  // ===========================================================================
  describe('CONFIG_GET handler', () => {
    let handler: (...args: unknown[]) => unknown;

    beforeEach(() => {
      handler = handlers.get(IPC_CHANNELS.CONFIG_GET)!;
    });

    it('should return full configuration', async () => {
      const result = await handler({});

      expect(mockConfigService.getConfig).toHaveBeenCalled();
      expect(result).toEqual(defaultConfig);
    });

    it('should return config with OAuth token', async () => {
      mockConfigService.getConfig.mockResolvedValue({
        ...defaultConfig,
        oauthToken: 'oauth_token_123',
        authMethod: 'oauth',
      });

      const result = await handler({}) as AppConfig;

      expect(result.oauthToken).toBe('oauth_token_123');
      expect(result.authMethod).toBe('oauth');
    });

    it('should return config with API key', async () => {
      mockConfigService.getConfig.mockResolvedValue({
        ...defaultConfig,
        apiKey: 'sk-ant-api-key',
        authMethod: 'api-key',
      });

      const result = await handler({}) as AppConfig;

      expect(result.apiKey).toBe('sk-ant-api-key');
      expect(result.authMethod).toBe('api-key');
    });

    it('should throw when config service is not initialized', async () => {
      handlers.clear();
      setupConfigIPC(null as any, mockGetMainWindow as any);
      const nullHandler = handlers.get(IPC_CHANNELS.CONFIG_GET)!;

      await expect(nullHandler({})).rejects.toThrow(ConfigurationError);
    });

    it('should throw when getConfig returns null', async () => {
      mockConfigService.getConfig.mockResolvedValue(null);

      await expect(handler({})).rejects.toThrow(ConfigurationError);
    });

    it('should propagate config service errors', async () => {
      mockConfigService.getConfig.mockRejectedValue(new Error('Storage corrupted'));

      await expect(handler({})).rejects.toThrow(ConfigurationError);
    });

    it('should return config with all theme modes', async () => {
      for (const theme of ['light', 'dark', 'system'] as const) {
        mockConfigService.getConfig.mockResolvedValue({
          ...defaultConfig,
          theme,
        });

        const result = await handler({}) as AppConfig;
        expect(result.theme).toBe(theme);
      }
    });

    it('should return config with different font sizes', async () => {
      mockConfigService.getConfig.mockResolvedValue({
        ...defaultConfig,
        fontSize: 18,
      });

      const result = await handler({}) as AppConfig;
      expect(result.fontSize).toBe(18);
    });
  });

  // ===========================================================================
  // CONFIG_SET
  // ===========================================================================
  describe('CONFIG_SET handler', () => {
    let handler: (...args: unknown[]) => unknown;

    beforeEach(() => {
      handler = handlers.get(IPC_CHANNELS.CONFIG_SET)!;
    });

    it('should update configuration with partial config', async () => {
      const update = { theme: 'dark' as const };

      await handler({}, update);

      expect(mockConfigService.setConfig).toHaveBeenCalledWith(update);
    });

    it('should notify renderer of config change', async () => {
      const update = { theme: 'dark' as const };

      await handler({}, update);

      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPC_CHANNELS.CONFIG_CHANGED,
        update
      );
    });

    it('should update multiple config values', async () => {
      const update = {
        theme: 'light' as const,
        fontSize: 16,
        autoApproveReads: false,
      };

      await handler({}, update);

      expect(mockConfigService.setConfig).toHaveBeenCalledWith(update);
    });

    it('should update working directory', async () => {
      const update = { workingDirectory: '/new/directory' };

      await handler({}, update);

      expect(mockConfigService.setConfig).toHaveBeenCalledWith(update);
    });

    it('should throw when config is not an object', async () => {
      await expect(handler({}, 'not-an-object')).rejects.toThrow(ConfigurationError);
    });

    it('should throw when config is null', async () => {
      await expect(handler({}, null)).rejects.toThrow(ConfigurationError);
    });

    it('should throw when config is undefined', async () => {
      await expect(handler({}, undefined)).rejects.toThrow(ConfigurationError);
    });

    it('should pass arrays to service (validateObject does not reject arrays)', async () => {
      // Note: validateObject checks typeof === 'object' && !== null, which arrays pass
      // This is a limitation - arrays with length > 0 pass validation and get sent to setConfig
      const arrayConfig = ['theme', 'dark'];
      await handler({}, arrayConfig);

      // Arrays pass validation and get forwarded to the service
      expect(mockConfigService.setConfig).toHaveBeenCalledWith(arrayConfig);
    });

    it('should throw when config is empty object', async () => {
      await expect(handler({}, {})).rejects.toThrow(ConfigurationError);
    });

    it('should throw when config service is not initialized', async () => {
      handlers.clear();
      setupConfigIPC(null as any, mockGetMainWindow as any);
      const nullHandler = handlers.get(IPC_CHANNELS.CONFIG_SET)!;

      await expect(nullHandler({}, { theme: 'dark' })).rejects.toThrow(ConfigurationError);
    });

    it('should propagate config service errors', async () => {
      mockConfigService.setConfig.mockRejectedValue(new Error('Storage full'));

      await expect(handler({}, { theme: 'dark' })).rejects.toThrow(ConfigurationError);
    });

    it('should handle window being null during notification', async () => {
      mockGetMainWindow.mockReturnValue(null as any);
      const update = { theme: 'dark' as const };

      // Should not throw
      await expect(handler({}, update)).resolves.toBeUndefined();
    });

    it('should handle OAuth token updates', async () => {
      const update = {
        oauthToken: 'new_oauth_token',
        authMethod: 'oauth' as const,
      };

      await handler({}, update);

      expect(mockConfigService.setConfig).toHaveBeenCalledWith(update);
    });

    it('should handle API key updates', async () => {
      const update = {
        apiKey: 'sk-ant-new-api-key',
        authMethod: 'api-key' as const,
      };

      await handler({}, update);

      expect(mockConfigService.setConfig).toHaveBeenCalledWith(update);
    });

    it('should handle clearing credentials', async () => {
      const update = {
        oauthToken: '',
        apiKey: '',
        authMethod: 'none' as const,
      };

      await handler({}, update);

      expect(mockConfigService.setConfig).toHaveBeenCalledWith(update);
    });
  });
});
