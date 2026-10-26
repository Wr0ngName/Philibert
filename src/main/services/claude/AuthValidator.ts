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
 * Pure (config-independent) OAuth token format validator. Exposed as a
 * free function so callers that don't have a ConfigService — notably
 * AuthService at extraction time — can vet a token before storage.
 */
export function validateOAuthTokenFormat(token: string): ValidationResult {
  if (!token || token.trim().length === 0) {
    return { valid: false, error: 'Token is empty' };
  }

  if (token.length < MAIN_CONSTANTS.AUTH.OAUTH_TOKEN_MIN_LENGTH) {
    return {
      valid: false,
      error: `Token too short (${token.length} chars, expected at least ${MAIN_CONSTANTS.AUTH.OAUTH_TOKEN_MIN_LENGTH}). Likely PTY stripping corrupted the capture.`,
    };
  }

  if (token.length > MAIN_CONSTANTS.AUTH.OAUTH_TOKEN_MAX_LENGTH) {
    return {
      valid: false,
      error: `Token too long (${token.length} chars, max ${MAIN_CONSTANTS.AUTH.OAUTH_TOKEN_MAX_LENGTH}). Likely extraction captured surrounding output.`,
    };
  }

  const prefixes = MAIN_CONSTANTS.AUTH.KNOWN_TOKEN_TYPE_PREFIXES;
  const matchedPrefix = prefixes.find(p => token.startsWith(p));
  if (!matchedPrefix) {
    return {
      valid: false,
      error: `Token prefix unrecognised (got "${token.slice(0, 14)}…", expected one of: ${prefixes.join(', ')}). Possible PTY corruption.`,
    };
  }

  const body = token.slice(matchedPrefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) {
    return {
      valid: false,
      error: 'Token body contains characters outside the base64url alphabet. Possible PTY corruption or leaked terminal escape.',
    };
  }

  return { valid: true };
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
   * Validate OAuth token format. Delegates to the pure free function so
   * AuthService can vet tokens without instantiating this class.
   */
  validateOAuthToken(token: string): ValidationResult {
    return validateOAuthTokenFormat(token);
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
    // (no refresh capability).
    const oauthToken = await this.configService.getOAuthToken();
    if (oauthToken) {
      const validation = this.validateOAuthToken(oauthToken);
      if (!validation.valid) {
        logger.error('Invalid OAuth token', { error: validation.error });
        throw new Error(`Invalid OAuth token: ${validation.error}. Please log out and log in again.`);
      }
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
