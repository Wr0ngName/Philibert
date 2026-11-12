/**
 * Authentication Validator for Claude Code
 *
 * Validates OAuth tokens and API keys.
 * Extracted from ClaudeCodeService for better separation of concerns.
 */

import { MAIN_CONSTANTS } from '../../constants/app';
import logger from '../../utils/logger';
import type ConfigService from '../ConfigService';

import { hasCliLogin } from './cliCredentials';

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates authentication credentials
 */
export class AuthValidator {
  private configService: ConfigService;

  constructor(configService: ConfigService) {
    this.configService = configService;
  }

  /**
   * Check if authentication is configured (OAuth or API key)
   */
  async hasAuth(): Promise<boolean> {
    // A CLI login is only a login while the CLI still has it.
    if (await this.configService.usesCliLogin()) return hasCliLogin();
    return await this.configService.hasAuth();
  }

  /**
   * Validate API key format
   * Valid API keys have format: sk-ant-api03-... or sk-...
   */
  validateApiKey(key: string): ValidationResult {
    if (!key || key.trim().length === 0) {
      return { valid: false, error: 'API key is empty' };
    }

    if (!key.startsWith('sk-')) {
      return { valid: false, error: 'API key must start with sk-' };
    }

    if (key.length < MAIN_CONSTANTS.AUTH.API_KEY_MIN_LENGTH) {
      return { valid: false, error: `API key too short (${key.length} chars)` };
    }

    return { valid: true };
  }

  /**
   * Set up environment variables for Claude Code SDK authentication
   * @returns Environment variables to set, or throws if validation fails
   */
  async setupAuthEnv(): Promise<Record<string, string>> {
    const env: Record<string, string> = {};

    // A login made with `claude auth login` is the CLI's own: it is in the
    // CLI's config directory, which the CLI refreshes and which also holds
    // the sessions, settings and agents. Nothing is passed — no token, no
    // CLAUDE_CONFIG_DIR — so the CLI runs exactly as it does in a terminal.
    // See cliCredentials.ts.
    if (await this.configService.usesCliLogin()) {
      if (!hasCliLogin()) {
        logger.warn('The Claude CLI login is gone (logged out elsewhere?)');
        throw new Error('You are no longer logged in to Claude (the login was removed, for example by `claude auth logout`). Log in again in Settings.');
      }
      logger.debug('Using the Claude CLI login');
      return env;
    }

    // A bare token from a `setup-token` login made before `auth login`
    // (no refresh capability). Passed as it is: Claude decides whether it is
    // valid, and a 401 logs Philibert out (handleAuthInvalidated).
    const oauthToken = await this.configService.getOAuthToken();
    if (oauthToken) {
      env['CLAUDE_CODE_OAUTH_TOKEN'] = oauthToken;
      logger.debug('Using OAuth token for authentication (no refresh)', { tokenLength: oauthToken.length });
      return env;
    }

    // Fall back to API key
    const apiKey = await this.configService.getApiKey();
    if (apiKey) {
      const validation = this.validateApiKey(apiKey);
      if (!validation.valid) {
        logger.error('Invalid API key', { error: validation.error });
        throw new Error(`Invalid API key: ${validation.error}. Please check your API key.`);
      }
      env['ANTHROPIC_API_KEY'] = apiKey;
      logger.debug('Using API key for authentication', { keyLength: apiKey.length });
      return env;
    }

    logger.warn('No authentication credentials configured');
    return env;
  }
}

export default AuthValidator;
