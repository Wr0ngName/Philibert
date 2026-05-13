/**
 * Configuration service for storing and retrieving app settings
 * Uses electron-store with safeStorage for secure API key storage
 */

import { safeStorage, dialog } from 'electron';

import { AppConfig, AuthMethod, DEFAULT_CONFIG, LogLevel, UpdateChannel } from '../../shared/types';
import { MAIN_CONSTANTS } from '../constants/app';
import { ConfigurationError, ERROR_CODES } from '../errors';
import logger, { setLogLevel } from '../utils/logger';

/**
 * Configuration values stored by electron-store.
 * Sensitive values (API keys, tokens) are stored encrypted.
 */
interface StoredConfig {
  encryptedApiKey?: string;
  encryptedOAuthToken?: string;
  authMethod: AuthMethod;
  workingDirectory: string;
  recentProjects: string[];
  theme: 'light' | 'dark' | 'system';
  fontSize: number;
  autoApproveReads: boolean;
  logLevel: LogLevel;
  selectedModel: string;
  enableNotifications: boolean;
  lastConversationId: string;
  updateChannel: UpdateChannel;
}

/**
 * Interface matching electron-store API for type safety.
 * electron-store extends Conf which provides these methods.
 * We use [key: string]: unknown to satisfy Record<string, unknown> constraint.
 */
interface TypedStore {
  get<K extends keyof StoredConfig>(key: K): StoredConfig[K] | undefined;
  get<K extends keyof StoredConfig>(key: K, defaultValue: StoredConfig[K]): StoredConfig[K];
  set<K extends keyof StoredConfig>(key: K, value: StoredConfig[K]): void;
  delete<K extends keyof StoredConfig>(key: K): void;
  clear(): void;
  readonly store: StoredConfig;
}

type StoreInstance = TypedStore | null;

export class ConfigService {
  private store: StoreInstance = null;
  private initPromise: Promise<void> | null = null;
  private isInitialized: boolean = false;

  constructor() {
    // Don't start initialization in constructor - let ensureInitialized handle it
    // This avoids race conditions when multiple callers try to initialize
  }

  private async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Dynamic import for ESM-only electron-store v10
      const { default: Store } = await import('electron-store');
      // Cast to our TypedStore interface for type safety while maintaining
      // compatibility with electron-store's complex generic types
      this.store = new Store({
        name: 'config',
        defaults: {
          authMethod: 'none',
          workingDirectory: '',
          recentProjects: [],
          theme: 'system',
          fontSize: 14,
          autoApproveReads: true,
          logLevel: 'warn',
          selectedModel: '',
          enableNotifications: true,
          lastConversationId: '',
          updateChannel: 'stable',
        },
      }) as unknown as TypedStore;
      this.isInitialized = true;
      // Note: Don't clear initPromise here - keep it so concurrent callers can await it

      // Apply log level from config on startup
      const storedLogLevel = this.store.get('logLevel', 'info') as LogLevel;
      setLogLevel(storedLogLevel);

      logger.info('ConfigService initialized');
    } catch (error) {
      // Clear promise on failure so retry is possible
      this.initPromise = null;
      logger.error('Failed to initialize ConfigService', error);
      throw error;
    }
  }

  /**
   * Ensure store is initialized before use.
   * Thread-safe: multiple concurrent calls will all await the same initialization.
   */
  async ensureInitialized(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    // Create promise only if not already initializing
    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }
    await this.initPromise;
  }

  /**
   * Get the full app configuration
   */
  async getConfig(): Promise<AppConfig> {
    await this.ensureInitialized();
    if (!this.store) throw new ConfigurationError('Store not initialized', ERROR_CODES.CONFIG_LOAD_FAILED);

    const storedConfig = this.store.store;

    let apiKey = '';
    try {
      apiKey = await this.getApiKey();
    } catch (error) {
      logger.warn('Failed to decrypt API key — re-authentication required', error);
    }

    let oauthToken = '';
    try {
      oauthToken = await this.getOAuthToken();
    } catch (error) {
      logger.warn('Failed to decrypt OAuth token — re-authentication required', error);
    }

    return {
      ...DEFAULT_CONFIG,
      ...storedConfig,
      apiKey,
      oauthToken,
    };
  }

  /**
   * Update configuration (partial update)
   */
  async setConfig(config: Partial<AppConfig>): Promise<void> {
    await this.ensureInitialized();
    if (!this.store) throw new ConfigurationError('Store not initialized', ERROR_CODES.CONFIG_SAVE_FAILED);

    const { apiKey, oauthToken, ...rest } = config;

    // Store API key securely if provided
    if (apiKey !== undefined) {
      await this.setApiKey(apiKey);
    }

    // Store OAuth token securely if provided
    if (oauthToken !== undefined) {
      await this.setOAuthToken(oauthToken);
    }

    // Store other config values
    Object.entries(rest).forEach(([key, value]) => {
      if (value !== undefined) {
        this.store!.set(key as keyof StoredConfig, value as StoredConfig[keyof StoredConfig]);
      }
    });

    // Apply log level change immediately
    if (rest.logLevel !== undefined) {
      setLogLevel(rest.logLevel);
    }

    logger.info('Config updated', { keys: Object.keys(config) });
  }

  /**
   * Set an encrypted value in the store
   * @param key - Must be 'encryptedApiKey' or 'encryptedOAuthToken'
   * @param value - The value to encrypt and store
   * @throws Error if encryption is not available
   */
  private async setEncryptedValue(key: 'encryptedApiKey' | 'encryptedOAuthToken', value: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.store) throw new ConfigurationError('Store not initialized', ERROR_CODES.CONFIG_SAVE_FAILED);

    if (!value) {
      this.store.delete(key);
      return;
    }

    if (!safeStorage.isEncryptionAvailable()) {
      // Fallback to plain text storage when keyring is unavailable (Linux without gnome-keyring, etc.)
      // Ask user for confirmation before storing insecurely (async to avoid freezing app)
      const keyDescription = key === 'encryptedApiKey' ? 'API Key' : 'OAuth Token';

      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'Secure Storage Unavailable',
        message: `Cannot encrypt your ${keyDescription} securely`,
        detail: 'Your system does not have a keyring daemon running (e.g., gnome-keyring, kwallet).\n\n' +
          `If you continue, your ${keyDescription} will be stored in PLAIN TEXT on disk, which is less secure.\n\n` +
          'To enable secure storage on Linux, install and start gnome-keyring or kwallet.',
        buttons: ['Store Insecurely', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      });

      if (response === 1) {
        // User cancelled
        logger.info('User declined to store credentials insecurely');
        throw new ConfigurationError(
          'Secure storage is not available and user declined insecure storage. Please install a keyring daemon.',
          ERROR_CODES.AUTH_ENCRYPTION_UNAVAILABLE
        );
      }

      // User accepted insecure storage
      logger.warn(`SafeStorage encryption not available, storing ${key} without encryption (INSECURE) - user approved`);
      this.store.set(key, `plain:${value}`);
      return;
    }

    try {
      const encrypted = safeStorage.encryptString(value);
      this.store.set(key, encrypted.toString('base64'));
      logger.debug(`${key} stored securely`, { length: value.length });
    } catch (error) {
      logger.error(`Failed to encrypt ${key}`, error);
      throw new ConfigurationError(`Failed to encrypt ${key}: ${error instanceof Error ? error.message : 'Unknown error'}`, ERROR_CODES.CONFIG_SAVE_FAILED, error);
    }
  }

  /**
   * Get an encrypted value from the store
   * @param key - Must be 'encryptedApiKey' or 'encryptedOAuthToken'
   * @returns Decrypted value or empty string if not found
   */
  private async getEncryptedValue(key: 'encryptedApiKey' | 'encryptedOAuthToken'): Promise<string> {
    await this.ensureInitialized();
    if (!this.store) throw new ConfigurationError('Store not initialized', ERROR_CODES.CONFIG_LOAD_FAILED);

    const storedValue = this.store.get(key) as string | undefined;
    if (!storedValue) {
      return '';
    }

    // Check if this is a plain text fallback value (from when encryption wasn't available)
    if (storedValue.startsWith('plain:')) {
      logger.warn(`Retrieving ${key} from plain text storage (INSECURE)`);
      return storedValue.slice(6); // Remove 'plain:' prefix
    }

    if (!safeStorage.isEncryptionAvailable()) {
      logger.error(`SafeStorage encryption not available, cannot decrypt ${key}`);
      throw new ConfigurationError('SafeStorage encryption is not available. Cannot decrypt credentials.', ERROR_CODES.AUTH_ENCRYPTION_UNAVAILABLE);
    }

    try {
      const decrypted = safeStorage.decryptString(Buffer.from(storedValue, 'base64'));
      logger.debug(`${key} retrieved from secure storage`, { length: decrypted.length });
      return decrypted;
    } catch (error) {
      logger.error(`Failed to decrypt ${key}`, error);
      // Clear the corrupted value to prevent repeated failures
      this.store.delete(key);
      throw new ConfigurationError(
        `Failed to decrypt ${key}. Your credentials may have been corrupted. Please log in again.`,
        ERROR_CODES.AUTH_ENCRYPTION_UNAVAILABLE,
        error
      );
    }
  }

  /**
   * Get API key (decrypted)
   */
  async getApiKey(): Promise<string> {
    return this.getEncryptedValue('encryptedApiKey');
  }

  /**
   * Set API key (encrypted) and update authMethod accordingly
   */
  async setApiKey(apiKey: string): Promise<void> {
    await this.setEncryptedValue('encryptedApiKey', apiKey);
    await this.updateAuthMethod();
  }

  /**
   * Check if API key is configured
   */
  async hasApiKey(): Promise<boolean> {
    await this.ensureInitialized();
    if (!this.store) return false;
    return !!this.store.get('encryptedApiKey');
  }

  /**
   * Get OAuth token (decrypted)
   */
  async getOAuthToken(): Promise<string> {
    return this.getEncryptedValue('encryptedOAuthToken');
  }

  /**
   * Set OAuth token (encrypted) and update authMethod accordingly
   */
  async setOAuthToken(token: string): Promise<void> {
    await this.setEncryptedValue('encryptedOAuthToken', token);
    await this.updateAuthMethod();
  }

  /**
   * Check if OAuth token is configured
   */
  async hasOAuthToken(): Promise<boolean> {
    await this.ensureInitialized();
    if (!this.store) return false;
    return !!this.store.get('encryptedOAuthToken');
  }

  /**
   * Check if any authentication is configured
   */
  async hasAuth(): Promise<boolean> {
    return (await this.hasApiKey()) || (await this.hasOAuthToken());
  }

  /**
   * Update authMethod based on current credentials.
   * OAuth takes priority over API key.
   */
  private async updateAuthMethod(): Promise<void> {
    if (!this.store) return;

    const hasOAuth = await this.hasOAuthToken();
    const hasApiKey = await this.hasApiKey();

    let authMethod: AuthMethod;
    if (hasOAuth) {
      authMethod = 'oauth';
    } else if (hasApiKey) {
      authMethod = 'api-key';
    } else {
      authMethod = 'none';
    }

    this.store.set('authMethod', authMethod);
    logger.debug('authMethod updated', { authMethod });
  }

  /**
   * Clear all authentication credentials and reset authMethod
   */
  async logout(): Promise<void> {
    await this.ensureInitialized();
    if (!this.store) return;

    this.store.delete('encryptedApiKey');
    this.store.delete('encryptedOAuthToken');
    this.store.set('authMethod', 'none');

    logger.info('User logged out, credentials cleared');
  }

  /**
   * Get working directory
   */
  async getWorkingDirectory(): Promise<string> {
    await this.ensureInitialized();
    if (!this.store) return '';
    return this.store.get('workingDirectory', '');
  }

  /**
   * Set working directory and add to recent projects
   */
  async setWorkingDirectory(directory: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.store) throw new ConfigurationError('Store not initialized', ERROR_CODES.CONFIG_SAVE_FAILED);

    this.store.set('workingDirectory', directory);

    // Update recent projects
    const recent = this.store.get('recentProjects', []) as string[];
    const filtered = recent.filter((p: string) => p !== directory);
    const updated = [directory, ...filtered].slice(0, MAIN_CONSTANTS.CONFIG.MAX_RECENT_PROJECTS);
    this.store.set('recentProjects', updated);

    logger.info('Working directory updated', { directory });
  }

  /**
   * Get recent projects
   */
  async getRecentProjects(): Promise<string[]> {
    await this.ensureInitialized();
    if (!this.store) return [];
    return this.store.get('recentProjects', []);
  }

  /**
   * Get theme preference
   */
  async getTheme(): Promise<'light' | 'dark' | 'system'> {
    await this.ensureInitialized();
    if (!this.store) return 'system';
    return this.store.get('theme', 'system');
  }

  /**
   * Get selected model
   */
  async getSelectedModel(): Promise<string> {
    await this.ensureInitialized();
    if (!this.store) return '';
    return this.store.get('selectedModel', '');
  }

  /**
   * Set selected model
   */
  async setSelectedModel(model: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.store) throw new ConfigurationError('Store not initialized', ERROR_CODES.CONFIG_SAVE_FAILED);

    this.store.set('selectedModel', model);
    logger.info('Selected model updated', { model: model || '(SDK default)' });
  }

  /**
   * Get update channel
   */
  async getUpdateChannel(): Promise<UpdateChannel> {
    await this.ensureInitialized();
    if (!this.store) return 'stable';
    return this.store.get('updateChannel', 'stable');
  }

  /**
   * Set update channel
   */
  async setUpdateChannel(channel: UpdateChannel): Promise<void> {
    await this.ensureInitialized();
    if (!this.store) throw new ConfigurationError('Store not initialized', ERROR_CODES.CONFIG_SAVE_FAILED);

    this.store.set('updateChannel', channel);
    logger.info('Update channel changed', { channel });
  }

  /**
   * Clear all stored data
   */
  async clear(): Promise<void> {
    await this.ensureInitialized();
    if (!this.store) return;
    this.store.clear();
    logger.info('Config cleared');
  }
}

export default ConfigService;
