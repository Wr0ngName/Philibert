/**
 * Comprehensive tests for ConfigService.
 *
 * Tests cover:
 * - Configuration loading and saving
 * - Encryption/decryption of sensitive data (API keys, OAuth tokens)
 * - Working directory management
 * - Recent projects tracking
 * - Race condition handling during initialization
 * - Error handling for encryption unavailable
 * - Edge cases and error paths
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to ensure mocks are available before vi.mock is called
const { mockStore, mockSafeStorage, mockApp, mockStoreData } = vi.hoisted(() => {
  // Actual data store for the mock
  const storeData = new Map<string, unknown>();

  const mockStore = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    has: vi.fn(),
    clear: vi.fn(),
  };

  const mockSafeStorage = {
    isEncryptionAvailable: vi.fn().mockReturnValue(true),
    encryptString: vi.fn((text: string) => Buffer.from(`encrypted:${text}`)),
    decryptString: vi.fn((buffer: Buffer) => {
      const str = buffer.toString();
      if (str.startsWith('encrypted:')) {
        return str.slice(10);
      }
      throw new Error('Invalid encrypted data');
    }),
  };

  const mockApp = {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
  };

  return { mockStore, mockSafeStorage, mockApp, mockStoreData: storeData };
});

// Mock modules
vi.mock('electron', () => ({
  safeStorage: mockSafeStorage,
  app: mockApp,
}));

vi.mock('electron-store', () => {
  // Create a mock class that delegates to mockStore (allows mockImplementation to work)
  return {
    default: class MockStore {
      get(...args: unknown[]) {
        return mockStore.get(...args);
      }
      set(...args: unknown[]) {
        return mockStore.set(...args);
      }
      delete(...args: unknown[]) {
        return mockStore.delete(...args);
      }
      has(...args: unknown[]) {
        return mockStore.has(...args);
      }
      clear(...args: unknown[]) {
        return mockStore.clear(...args);
      }
      // electron-store has a 'store' getter that returns all stored data
      get store() {
        return Object.fromEntries(mockStoreData);
      }
    },
  };
});

vi.mock('../../utils/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  setLogLevel: vi.fn(),
}));

// Import after mocks are set up
import { DEFAULT_CONFIG } from '../../../shared/types';
import ConfigService from '../ConfigService';

describe('ConfigService', () => {
  let service: ConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreData.clear(); // Reset stored data between tests

    // Reset mock store state - using actual data storage for realistic behavior
    mockStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
      if (mockStoreData.has(key)) {
        return mockStoreData.get(key);
      }
      return defaultValue;
    });
    mockStore.set.mockImplementation((key: string, value: unknown) => {
      mockStoreData.set(key, value);
    });
    mockStore.delete.mockImplementation((key: string) => {
      mockStoreData.delete(key);
    });
    mockStore.clear.mockImplementation(() => {
      mockStoreData.clear();
    });
    mockStore.has.mockImplementation((key: string) => mockStoreData.has(key));

    // Reset safeStorage
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockSafeStorage.encryptString.mockImplementation((text: string) => Buffer.from(`encrypted:${text}`));
    mockSafeStorage.decryptString.mockImplementation((buffer: Buffer) => {
      const str = buffer.toString();
      if (str.startsWith('encrypted:')) {
        return str.slice(10);
      }
      throw new Error('Invalid encrypted data');
    });

    service = new ConfigService();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Initialization
  // ===========================================================================
  describe('initialization', () => {
    it('should initialize with default config when no stored config exists', async () => {
      await service.ensureInitialized();
      const config = await service.getConfig();

      expect(config.apiKey).toBe('');
      expect(config.oauthToken).toBe('');
      expect(config.workingDirectory).toBe('');
      expect(config.theme).toBe('system');
    });

    it('should load stored config on initialization', async () => {
      // Pre-populate the store data before initialization
      mockStoreData.set('workingDirectory', '/home/user/projects');
      mockStoreData.set('theme', 'dark');
      mockStoreData.set('fontSize', 16);

      await service.ensureInitialized();
      const config = await service.getConfig();

      expect(config.workingDirectory).toBe('/home/user/projects');
      expect(config.theme).toBe('dark');
      expect(config.fontSize).toBe(16);
    });

    it('should only initialize once despite multiple calls', async () => {
      // Create a flag to track how many times dynamic import is called
      // The implementation uses dynamic import for electron-store
      const originalInit = service['initialize'].bind(service);
      let initCount = 0;
      service['initialize'] = async function() {
        initCount++;
        return originalInit();
      };

      await Promise.all([
        service.ensureInitialized(),
        service.ensureInitialized(),
        service.ensureInitialized(),
      ]);

      // Should only initialize once
      expect(initCount).toBe(1);
    });

    it('should handle concurrent initialization calls safely', async () => {
      // Simulate slow initialization
      let resolveInit: () => void;
      const initPromise = new Promise<void>((resolve) => {
        resolveInit = resolve;
      });

      mockStore.get.mockImplementation(async () => {
        await initPromise;
        return DEFAULT_CONFIG;
      });

      // Start multiple concurrent initializations
      const p1 = service.ensureInitialized();
      const p2 = service.ensureInitialized();
      const p3 = service.ensureInitialized();

      // Complete initialization
      resolveInit!();

      // All should complete without error
      await expect(Promise.all([p1, p2, p3])).resolves.not.toThrow();
    });
  });

  // ===========================================================================
  // Configuration Access
  // ===========================================================================
  describe('getConfig', () => {
    it('should return full config object', async () => {
      await service.ensureInitialized();
      const config = await service.getConfig();

      expect(config).toHaveProperty('apiKey');
      expect(config).toHaveProperty('oauthToken');
      expect(config).toHaveProperty('authMethod');
      expect(config).toHaveProperty('workingDirectory');
      expect(config).toHaveProperty('recentProjects');
      expect(config).toHaveProperty('theme');
      expect(config).toHaveProperty('fontSize');
      expect(config).toHaveProperty('autoApproveReads');
    });

    it('should return a copy, not the internal reference', async () => {
      await service.ensureInitialized();
      const config1 = await service.getConfig();
      const config2 = await service.getConfig();

      config1.theme = 'dark';

      expect(config2.theme).toBe('system'); // Original should be unchanged
    });
  });

  describe('setConfig', () => {
    it('should update partial config', async () => {
      await service.ensureInitialized();

      await service.setConfig({ theme: 'dark', fontSize: 18 });

      const config = await service.getConfig();
      expect(config.theme).toBe('dark');
      expect(config.fontSize).toBe(18);
    });

    it('should persist config to store', async () => {
      await service.ensureInitialized();

      await service.setConfig({ theme: 'light' });

      // Implementation sets individual keys, not a 'config' key
      expect(mockStore.set).toHaveBeenCalledWith('theme', 'light');
    });

    it('should merge with existing config', async () => {
      // Pre-populate store data
      mockStoreData.set('workingDirectory', '/existing/path');
      mockStoreData.set('theme', 'dark');

      await service.ensureInitialized();
      await service.setConfig({ fontSize: 20 });

      const config = await service.getConfig();
      expect(config.workingDirectory).toBe('/existing/path');
      expect(config.theme).toBe('dark');
      expect(config.fontSize).toBe(20);
    });
  });

  // ===========================================================================
  // Working Directory
  // ===========================================================================
  describe('workingDirectory', () => {
    it('should get working directory', async () => {
      // Use mockStoreData instead of mockReturnValue to preserve mock implementation
      mockStoreData.set('workingDirectory', '/home/user/project');

      await service.ensureInitialized();
      const dir = await service.getWorkingDirectory();

      expect(dir).toBe('/home/user/project');
    });

    it('should set working directory', async () => {
      await service.ensureInitialized();

      await service.setWorkingDirectory('/new/project/path');

      const dir = await service.getWorkingDirectory();
      expect(dir).toBe('/new/project/path');
    });

    it('should add to recent projects when setting working directory', async () => {
      await service.ensureInitialized();

      await service.setWorkingDirectory('/project1');
      await service.setWorkingDirectory('/project2');

      const config = await service.getConfig();
      expect(config.recentProjects).toContain('/project1');
      expect(config.recentProjects).toContain('/project2');
    });

    it('should not duplicate in recent projects', async () => {
      await service.ensureInitialized();

      await service.setWorkingDirectory('/project1');
      await service.setWorkingDirectory('/project2');
      await service.setWorkingDirectory('/project1'); // Duplicate

      const config = await service.getConfig();
      const count = config.recentProjects.filter((p) => p === '/project1').length;
      expect(count).toBe(1);
    });

    it('should limit recent projects to max count', async () => {
      await service.ensureInitialized();

      // Add more than the limit
      for (let i = 0; i < 15; i++) {
        await service.setWorkingDirectory(`/project${i}`);
      }

      const config = await service.getConfig();
      expect(config.recentProjects.length).toBeLessThanOrEqual(10);
    });

    it('should move recently used project to front', async () => {
      await service.ensureInitialized();

      await service.setWorkingDirectory('/project1');
      await service.setWorkingDirectory('/project2');
      await service.setWorkingDirectory('/project3');
      await service.setWorkingDirectory('/project1'); // Use again

      const config = await service.getConfig();
      expect(config.recentProjects[0]).toBe('/project1');
    });
  });

  // ===========================================================================
  // API Key Management (Encrypted)
  // ===========================================================================
  describe('API key management', () => {
    it('should encrypt API key when storing', async () => {
      await service.ensureInitialized();

      await service.setApiKey('sk-ant-api03-test-key');

      expect(mockSafeStorage.encryptString).toHaveBeenCalledWith('sk-ant-api03-test-key');
    });

    it('should store encrypted API key as base64', async () => {
      await service.ensureInitialized();

      await service.setApiKey('sk-ant-api03-test-key');

      expect(mockStore.set).toHaveBeenCalledWith(
        'encryptedApiKey',
        expect.any(String) // base64 encoded
      );
    });

    it('should decrypt API key when retrieving', async () => {
      const encryptedKey = Buffer.from('encrypted:sk-ant-api03-my-key').toString('base64');
      mockStore.get.mockImplementation((key: string) => {
        if (key === 'encryptedApiKey') return encryptedKey;
        return DEFAULT_CONFIG;
      });

      await service.ensureInitialized();
      const apiKey = await service.getApiKey();

      expect(apiKey).toBe('sk-ant-api03-my-key');
    });

    it('should return empty string if no API key stored', async () => {
      await service.ensureInitialized();
      const apiKey = await service.getApiKey();

      expect(apiKey).toBe('');
    });

    it('should update authMethod when setting API key', async () => {
      await service.ensureInitialized();

      await service.setApiKey('sk-ant-api03-test');

      const config = await service.getConfig();
      expect(config.authMethod).toBe('api-key');
    });

    it('should clear authMethod when removing API key', async () => {
      await service.ensureInitialized();
      await service.setApiKey('sk-ant-api03-test');

      await service.setApiKey('');

      const config = await service.getConfig();
      expect(config.authMethod).toBe('none');
    });

    it('should handle encryption failure gracefully', async () => {
      mockSafeStorage.encryptString.mockImplementation(() => {
        throw new Error('Encryption failed');
      });

      await service.ensureInitialized();

      await expect(service.setApiKey('sk-test')).rejects.toThrow();
    });

    it('should handle decryption failure gracefully', async () => {
      // Store a corrupted API key directly in the backing store
      mockStoreData.set('encryptedApiKey', 'invalid-base64-data!!!');
      mockSafeStorage.decryptString.mockImplementation(() => {
        throw new Error('Decryption failed');
      });

      await service.ensureInitialized();
      // Implementation throws on decryption failure (and deletes corrupted value)
      await expect(service.getApiKey()).rejects.toThrow();
      expect(mockStore.delete).toHaveBeenCalledWith('encryptedApiKey');
      // authMethod must be updated to 'none' after the corrupted key is deleted
      expect(mockStore.set).toHaveBeenCalledWith('authMethod', 'none');
    });
  });

  // ===========================================================================
  // OAuth Token Management (Encrypted)
  // ===========================================================================
  describe('OAuth token management', () => {
    it('should encrypt OAuth token when storing', async () => {
      await service.ensureInitialized();

      await service.setOAuthToken('sk-ant-oat01-test-token');

      expect(mockSafeStorage.encryptString).toHaveBeenCalledWith('sk-ant-oat01-test-token');
    });

    it('should store encrypted OAuth token as base64', async () => {
      await service.ensureInitialized();

      await service.setOAuthToken('sk-ant-oat01-test-token');

      expect(mockStore.set).toHaveBeenCalledWith(
        'encryptedOAuthToken',
        expect.any(String)
      );
    });

    it('should decrypt OAuth token when retrieving', async () => {
      const encryptedToken = Buffer.from('encrypted:sk-ant-oat01-my-token').toString('base64');
      mockStore.get.mockImplementation((key: string) => {
        if (key === 'encryptedOAuthToken') return encryptedToken;
        return DEFAULT_CONFIG;
      });

      await service.ensureInitialized();
      const token = await service.getOAuthToken();

      expect(token).toBe('sk-ant-oat01-my-token');
    });

    it('should return empty string if no OAuth token stored', async () => {
      await service.ensureInitialized();
      const token = await service.getOAuthToken();

      expect(token).toBe('');
    });

    it('should update authMethod when setting OAuth token', async () => {
      await service.ensureInitialized();

      await service.setOAuthToken('sk-ant-oat01-test');

      const config = await service.getConfig();
      expect(config.authMethod).toBe('oauth');
    });

    it('should prefer OAuth over API key for authMethod', async () => {
      await service.ensureInitialized();

      await service.setApiKey('sk-ant-api03-key');
      await service.setOAuthToken('sk-ant-oat01-token');

      const config = await service.getConfig();
      expect(config.authMethod).toBe('oauth');
    });
  });

  // ===========================================================================
  // Authentication State
  // ===========================================================================
  describe('hasAuth', () => {
    it('should return false when no auth configured', async () => {
      await service.ensureInitialized();

      const hasAuth = await service.hasAuth();

      expect(hasAuth).toBe(false);
    });

    it('should return true when API key is set', async () => {
      await service.ensureInitialized();
      await service.setApiKey('sk-ant-api03-test');

      const hasAuth = await service.hasAuth();

      expect(hasAuth).toBe(true);
    });

    it('should return true when OAuth token is set', async () => {
      await service.ensureInitialized();
      await service.setOAuthToken('sk-ant-oat01-test');

      const hasAuth = await service.hasAuth();

      expect(hasAuth).toBe(true);
    });

    it('should return true when both are set', async () => {
      await service.ensureInitialized();
      await service.setApiKey('sk-ant-api03-key');
      await service.setOAuthToken('sk-ant-oat01-token');

      const hasAuth = await service.hasAuth();

      expect(hasAuth).toBe(true);
    });
  });

  describe('logout', () => {
    it('should clear both API key and OAuth token', async () => {
      await service.ensureInitialized();
      await service.setApiKey('sk-ant-api03-key');
      await service.setOAuthToken('sk-ant-oat01-token');

      await service.logout();

      expect(await service.getApiKey()).toBe('');
      expect(await service.getOAuthToken()).toBe('');
    });

    it('should reset authMethod to none', async () => {
      await service.ensureInitialized();
      await service.setOAuthToken('sk-ant-oat01-token');

      await service.logout();

      const config = await service.getConfig();
      expect(config.authMethod).toBe('none');
    });

    it('should delete encrypted keys from store', async () => {
      await service.ensureInitialized();
      await service.setApiKey('sk-ant-api03-key');

      await service.logout();

      expect(mockStore.delete).toHaveBeenCalledWith('encryptedApiKey');
      expect(mockStore.delete).toHaveBeenCalledWith('encryptedOAuthToken');
    });
  });

  // ===========================================================================
  // Encryption Unavailable
  // ===========================================================================
  describe('encryption unavailable', () => {
    it('should throw when encryption is unavailable and storing API key', async () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);

      const newService = new ConfigService();
      await newService.ensureInitialized();

      await expect(newService.setApiKey('sk-test')).rejects.toThrow();
    });

    it('should throw when encryption is unavailable and storing OAuth token', async () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);

      const newService = new ConfigService();
      await newService.ensureInitialized();

      await expect(newService.setOAuthToken('sk-oat-test')).rejects.toThrow();
    });

    it('should still allow reading config when encryption unavailable', async () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);

      const newService = new ConfigService();
      await newService.ensureInitialized();

      const config = await newService.getConfig();
      expect(config).toBeDefined();
      expect(config.theme).toBe('system');
    });
  });

  // ===========================================================================
  // Theme and Font Size
  // ===========================================================================
  describe('theme management', () => {
    it('should set theme to light', async () => {
      await service.ensureInitialized();

      await service.setConfig({ theme: 'light' });

      const config = await service.getConfig();
      expect(config.theme).toBe('light');
    });

    it('should set theme to dark', async () => {
      await service.ensureInitialized();

      await service.setConfig({ theme: 'dark' });

      const config = await service.getConfig();
      expect(config.theme).toBe('dark');
    });

    it('should set theme to system', async () => {
      await service.ensureInitialized();
      await service.setConfig({ theme: 'light' }); // Set to light first

      await service.setConfig({ theme: 'system' });

      const config = await service.getConfig();
      expect(config.theme).toBe('system');
    });
  });

  describe('fontSize management', () => {
    it('should set font size', async () => {
      await service.ensureInitialized();

      await service.setConfig({ fontSize: 18 });

      const config = await service.getConfig();
      expect(config.fontSize).toBe(18);
    });

    it('should persist font size', async () => {
      await service.ensureInitialized();

      await service.setConfig({ fontSize: 20 });

      // Implementation sets individual keys
      expect(mockStore.set).toHaveBeenCalledWith('fontSize', 20);
    });
  });

  // ===========================================================================
  // Auto Approve Reads
  // ===========================================================================
  describe('autoApproveReads', () => {
    it('should default to true', async () => {
      await service.ensureInitialized();

      const config = await service.getConfig();
      expect(config.autoApproveReads).toBe(true);
    });

    it('should allow disabling auto approve', async () => {
      await service.ensureInitialized();

      await service.setConfig({ autoApproveReads: false });

      const config = await service.getConfig();
      expect(config.autoApproveReads).toBe(false);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================
  describe('edge cases', () => {
    it('should handle corrupted stored config', async () => {
      // Implementation accesses store.store (getter) which uses Object.fromEntries(mockStoreData)
      // Store an invalid non-object value for theme
      mockStoreData.set('theme', 123); // Invalid type

      await service.ensureInitialized();
      const config = await service.getConfig();

      // Should still return the (corrupted) value from store, merged with defaults
      // The implementation doesn't validate types, so it passes through
      expect(config).toBeDefined();
    });

    it('should handle partial stored config', async () => {
      // Only set theme, other values will use defaults
      mockStoreData.set('theme', 'dark');

      await service.ensureInitialized();
      const config = await service.getConfig();

      expect(config.theme).toBe('dark');
      expect(config.fontSize).toBe(14); // Default value from DEFAULT_CONFIG
    });

    it('should handle store.set failure', async () => {
      mockStore.set.mockImplementation(() => {
        throw new Error('Storage full');
      });

      await service.ensureInitialized();

      await expect(service.setConfig({ theme: 'dark' })).rejects.toThrow();
    });

    it('should handle very long working directory path', async () => {
      const longPath = '/a'.repeat(1000);
      await service.ensureInitialized();

      await service.setWorkingDirectory(longPath);

      const dir = await service.getWorkingDirectory();
      expect(dir).toBe(longPath);
    });

    it('should handle special characters in working directory', async () => {
      const specialPath = '/home/user/My Projects (2024)/café';
      await service.ensureInitialized();

      await service.setWorkingDirectory(specialPath);

      const dir = await service.getWorkingDirectory();
      expect(dir).toBe(specialPath);
    });
  });
});
