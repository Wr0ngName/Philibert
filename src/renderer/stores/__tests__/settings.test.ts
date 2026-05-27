/**
 * Comprehensive tests for the settings store.
 *
 * Tests cover:
 * - Initial state
 * - Computed getters (hasApiKey, hasOAuthToken, hasAuth, isDarkMode, needsSetup)
 * - Config loading and saving
 * - Theme management and system theme detection
 * - Individual setting updates (API key, working directory, theme, font size)
 * - Event listener cleanup
 */

import { setActivePinia, createPinia } from 'pinia';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { DEFAULT_CONFIG } from '../../../shared/types';
import { useSettingsStore } from '../settings';

// Mock window.electron
const mockElectron = {
  config: {
    get: vi.fn(),
    set: vi.fn(),
    onChange: vi.fn(),
  },
};

// Mock window.matchMedia
const mockMatchMedia = vi.fn();

// Store the callbacks
 
let configChangeCallback: ((updates: any) => void) | null = null;

// Mock MediaQueryList
const mockMediaQueryList = {
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

describe('useSettingsStore', () => {
  beforeEach(() => {
    // Set up pinia
    setActivePinia(createPinia());

    // Reset mocks
    vi.clearAllMocks();
    configChangeCallback = null;

    // Set up window.electron mock
    (window as any).electron = mockElectron;

    // Set up window.matchMedia mock
    mockMatchMedia.mockReturnValue(mockMediaQueryList);
    window.matchMedia = mockMatchMedia;

    // Set up mock implementations
    mockElectron.config.get.mockResolvedValue({ ...DEFAULT_CONFIG });
    mockElectron.config.set.mockResolvedValue(undefined);
    mockElectron.config.onChange.mockImplementation((callback) => {
      configChangeCallback = callback;
      return () => {
        configChangeCallback = null;
      };
    });

    // Mock document.documentElement
    Object.defineProperty(document, 'documentElement', {
      value: {
        classList: {
          add: vi.fn(),
          remove: vi.fn(),
        },
      },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Initial State
  // ===========================================================================
  describe('initial state', () => {
    it('should have default config', () => {
      const store = useSettingsStore();
      expect(store.config).toEqual(DEFAULT_CONFIG);
    });

    it('should be loading initially', () => {
      const store = useSettingsStore();
      expect(store.isLoading).toBe(true);
    });

    it('should not be saving initially', () => {
      const store = useSettingsStore();
      expect(store.isSaving).toBe(false);
    });
  });

  // ===========================================================================
  // Computed Getters
  // ===========================================================================
  describe('computed getters', () => {
    it('hasApiKey should be false when no API key', () => {
      const store = useSettingsStore();
      expect(store.hasApiKey).toBe(false);
    });

    it('hasApiKey should be true when API key exists', async () => {
      mockElectron.config.get.mockResolvedValue({
        ...DEFAULT_CONFIG,
        apiKey: 'sk-ant-api-key',
      });

      const store = useSettingsStore();
      await store.loadConfig();

      expect(store.hasApiKey).toBe(true);
    });

    it('hasOAuthToken should be false when no OAuth token', () => {
      const store = useSettingsStore();
      expect(store.hasOAuthToken).toBe(false);
    });

    it('hasOAuthToken should be true when OAuth token exists', async () => {
      mockElectron.config.get.mockResolvedValue({
        ...DEFAULT_CONFIG,
        oauthToken: 'oauth_token_123',
      });

      const store = useSettingsStore();
      await store.loadConfig();

      expect(store.hasOAuthToken).toBe(true);
    });

    it('hasAuth should be false when no auth', () => {
      const store = useSettingsStore();
      expect(store.hasAuth).toBe(false);
    });

    it('hasAuth should be true when API key exists', async () => {
      mockElectron.config.get.mockResolvedValue({
        ...DEFAULT_CONFIG,
        apiKey: 'sk-ant-api-key',
      });

      const store = useSettingsStore();
      await store.loadConfig();

      expect(store.hasAuth).toBe(true);
    });

    it('hasAuth should be true when OAuth token exists', async () => {
      mockElectron.config.get.mockResolvedValue({
        ...DEFAULT_CONFIG,
        oauthToken: 'oauth_token_123',
      });

      const store = useSettingsStore();
      await store.loadConfig();

      expect(store.hasAuth).toBe(true);
    });

    it('workingDirectory should return current working directory', async () => {
      mockElectron.config.get.mockResolvedValue({
        ...DEFAULT_CONFIG,
        workingDirectory: '/home/user/project',
      });

      const store = useSettingsStore();
      await store.loadConfig();

      expect(store.workingDirectory).toBe('/home/user/project');
    });

    it('recentProjects should return recent projects list', async () => {
      mockElectron.config.get.mockResolvedValue({
        ...DEFAULT_CONFIG,
        recentProjects: ['/project1', '/project2'],
      });

      const store = useSettingsStore();
      await store.loadConfig();

      expect(store.recentProjects).toEqual(['/project1', '/project2']);
    });

    it('needsSetup should be true when no working directory', () => {
      const store = useSettingsStore();
      expect(store.needsSetup).toBe(true);
    });

    it('needsSetup should be true when no auth', () => {
      const store = useSettingsStore();
      store.config.workingDirectory = '/some/dir';
      expect(store.needsSetup).toBe(true);
    });

    it('needsSetup should be false when fully configured', async () => {
      mockElectron.config.get.mockResolvedValue({
        ...DEFAULT_CONFIG,
        workingDirectory: '/home/user/project',
        apiKey: 'sk-ant-api-key',
      });

      const store = useSettingsStore();
      await store.loadConfig();

      expect(store.needsSetup).toBe(false);
    });
  });

  // ===========================================================================
  // isDarkMode
  // ===========================================================================
  describe('isDarkMode', () => {
    it('should return true when theme is dark', async () => {
      mockElectron.config.get.mockResolvedValue({
        ...DEFAULT_CONFIG,
        theme: 'dark',
      });

      const store = useSettingsStore();
      await store.loadConfig();

      expect(store.isDarkMode).toBe(true);
    });

    it('should return false when theme is light', async () => {
      mockElectron.config.get.mockResolvedValue({
        ...DEFAULT_CONFIG,
        theme: 'light',
      });

      const store = useSettingsStore();
      await store.loadConfig();

      expect(store.isDarkMode).toBe(false);
    });

    it('should follow system preference when theme is system', async () => {
      mockElectron.config.get.mockResolvedValue({
        ...DEFAULT_CONFIG,
        theme: 'system',
      });

      // System prefers dark
      mockMediaQueryList.matches = true;

      const store = useSettingsStore();
      await store.loadConfig();

      expect(store.isDarkMode).toBe(true);
    });

    it('should return false for system theme when system prefers light', async () => {
      mockElectron.config.get.mockResolvedValue({
        ...DEFAULT_CONFIG,
        theme: 'system',
      });

      // System prefers light
      mockMediaQueryList.matches = false;

      const store = useSettingsStore();
      await store.loadConfig();

      expect(store.isDarkMode).toBe(false);
    });
  });

  // ===========================================================================
  // loadConfig
  // ===========================================================================
  describe('loadConfig', () => {
    it('should load config from main process', async () => {
      const loadedConfig = {
        ...DEFAULT_CONFIG,
        workingDirectory: '/home/user/project',
        theme: 'dark' as const,
      };
      mockElectron.config.get.mockResolvedValue(loadedConfig);

      const store = useSettingsStore();
      await store.loadConfig();

      expect(mockElectron.config.get).toHaveBeenCalled();
      expect(store.config.workingDirectory).toBe('/home/user/project');
      expect(store.config.theme).toBe('dark');
    });

    it('should set isLoading to false after loading', async () => {
      const store = useSettingsStore();
      await store.loadConfig();

      expect(store.isLoading).toBe(false);
    });

    it('should handle load errors gracefully', async () => {
      mockElectron.config.get.mockRejectedValue(new Error('Load failed'));

      const store = useSettingsStore();
      await store.loadConfig();

      expect(store.isLoading).toBe(false);
      // Should not throw
    });
  });

  // ===========================================================================
  // saveConfig
  // ===========================================================================
  describe('saveConfig', () => {
    it('should save config to main process', async () => {
      const store = useSettingsStore();
      await store.loadConfig();
      await store.saveConfig({ theme: 'dark' });

      expect(mockElectron.config.set).toHaveBeenCalledWith({ theme: 'dark' });
    });

    it('should update local state', async () => {
      const store = useSettingsStore();
      await store.loadConfig();
      await store.saveConfig({ theme: 'dark' });

      expect(store.config.theme).toBe('dark');
    });

    it('should set isSaving during save', async () => {
      const store = useSettingsStore();
      await store.loadConfig();

      let isSavingDuringSave = false;
      mockElectron.config.set.mockImplementation(async () => {
        isSavingDuringSave = store.isSaving;
      });

      await store.saveConfig({ theme: 'dark' });

      expect(isSavingDuringSave).toBe(true);
      expect(store.isSaving).toBe(false);
    });

    it('should propagate save errors', async () => {
      mockElectron.config.set.mockRejectedValue(new Error('Save failed'));

      const store = useSettingsStore();
      await store.loadConfig();

      await expect(store.saveConfig({ theme: 'dark' })).rejects.toThrow('Save failed');
      expect(store.isSaving).toBe(false);
    });
  });

  // ===========================================================================
  // Individual Setters
  // ===========================================================================
  describe('setApiKey', () => {
    it('should save API key', async () => {
      const store = useSettingsStore();
      await store.loadConfig();
      await store.setApiKey('sk-ant-new-key');

      expect(mockElectron.config.set).toHaveBeenCalledWith({ apiKey: 'sk-ant-new-key' });
    });
  });

  describe('setWorkingDirectory', () => {
    it('should save working directory', async () => {
      const store = useSettingsStore();
      await store.loadConfig();
      await store.setWorkingDirectory('/new/directory');

      expect(mockElectron.config.set).toHaveBeenCalledWith({ workingDirectory: '/new/directory' });
    });
  });

  describe('setTheme', () => {
    it('should save theme and apply it', async () => {
      const store = useSettingsStore();
      await store.loadConfig();
      await store.setTheme('dark');

      expect(mockElectron.config.set).toHaveBeenCalledWith({ theme: 'dark' });
      expect(document.documentElement.classList.add).toHaveBeenCalledWith('dark');
    });
  });

  describe('setFontSize', () => {
    it('should save font size', async () => {
      const store = useSettingsStore();
      await store.loadConfig();
      await store.setFontSize(16);

      expect(mockElectron.config.set).toHaveBeenCalledWith({ fontSize: 16 });
    });
  });

  describe('setLineHeight', () => {
    it('should save line height', async () => {
      const store = useSettingsStore();
      await store.loadConfig();
      await store.setLineHeight(1.2);

      expect(mockElectron.config.set).toHaveBeenCalledWith({ lineHeight: 1.2 });
    });
  });

  // ===========================================================================
  // applyTheme
  // ===========================================================================
  describe('applyTheme', () => {
    it('should add dark class for dark theme', () => {
      const store = useSettingsStore();
      store.applyTheme('dark');

      expect(document.documentElement.classList.add).toHaveBeenCalledWith('dark');
    });

    it('should remove dark class for light theme', () => {
      const store = useSettingsStore();
      store.applyTheme('light');

      expect(document.documentElement.classList.remove).toHaveBeenCalledWith('dark');
    });

    it('should follow system preference for system theme', () => {
      mockMediaQueryList.matches = true;

      const store = useSettingsStore();
      store.applyTheme('system');

      expect(document.documentElement.classList.add).toHaveBeenCalledWith('dark');
    });

    it('should remove dark class for system theme when system prefers light', () => {
      mockMediaQueryList.matches = false;

      const store = useSettingsStore();
      store.applyTheme('system');

      expect(document.documentElement.classList.remove).toHaveBeenCalledWith('dark');
    });
  });

  // ===========================================================================
  // initialize
  // ===========================================================================
  describe('initialize', () => {
    it('should load config and set up listeners', async () => {
      const store = useSettingsStore();
      store.initialize();

      // Wait for async operations
      await vi.waitFor(() => {
        expect(mockElectron.config.get).toHaveBeenCalled();
      });

      expect(mockElectron.config.onChange).toHaveBeenCalled();
      expect(mockMediaQueryList.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    });

    it('should update config when receiving changes from main process', async () => {
      const store = useSettingsStore();
      store.initialize();

      await vi.waitFor(() => {
        expect(configChangeCallback).not.toBeNull();
      });

      // Simulate config change from main process
      configChangeCallback?.({ theme: 'dark' });

      expect(store.config.theme).toBe('dark');
    });

    it('should apply theme when receiving theme change from main process', async () => {
      const store = useSettingsStore();
      store.initialize();

      await vi.waitFor(() => {
        expect(configChangeCallback).not.toBeNull();
      });

      configChangeCallback?.({ theme: 'dark' });

      expect(document.documentElement.classList.add).toHaveBeenCalledWith('dark');
    });
  });

  // ===========================================================================
  // cleanup
  // ===========================================================================
  describe('cleanup', () => {
    it('should unsubscribe from config changes', async () => {
      const unsubscribe = vi.fn();
      mockElectron.config.onChange.mockReturnValue(unsubscribe);

      const store = useSettingsStore();
      store.initialize();

      await vi.waitFor(() => {
        expect(mockElectron.config.onChange).toHaveBeenCalled();
      });

      store.cleanup();

      expect(unsubscribe).toHaveBeenCalled();
    });

    it('should remove system theme listener', async () => {
      const store = useSettingsStore();
      store.initialize();

      await vi.waitFor(() => {
        expect(mockMediaQueryList.addEventListener).toHaveBeenCalled();
      });

      store.cleanup();

      expect(mockMediaQueryList.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    });
  });
});
