/**
 * IPC handlers for authentication operations
 */


import { ipcMain, BrowserWindow } from 'electron';

import { IPC_CHANNELS, AuthStatus, type ClaudeAccount } from '../../shared/types';
import { MAIN_CONSTANTS } from '../constants/app';
import { AuthenticationError, ERROR_CODES } from '../errors';
import AuthService from '../services/AuthService';
import type { ClaudeCodeService } from '../services/ClaudeCodeService';
import ConfigService from '../services/ConfigService';
import { mergeOAuthAccount, removeCliCredentials, writeCliCredentials } from '../services/claude/cliCredentials';
import { validateString, sendToRenderer, ensureService, formatErrorMessage } from '../utils/ipc-helpers';
import logger from '../utils/logger';

export function setupAuthHandlers(
  authService: AuthService,
  configService: ConfigService,
  getMainWindow: () => BrowserWindow | null,
  claudeService: ClaudeCodeService
): void {
  // Get current authentication status
  ipcMain.handle(IPC_CHANNELS.AUTH_GET_STATUS, async (): Promise<AuthStatus> => {
    try {
      logger.debug('IPC: auth:get-status');

      // Validate services
      ensureService(authService, 'AuthService');
      ensureService(configService, 'ConfigService');

      const config = await configService.getConfig();

      if (!config) {
        throw new AuthenticationError('Failed to load configuration', ERROR_CODES.AUTH_NOT_CONFIGURED);
      }

      if (config.oauthToken) {
        return {
          isAuthenticated: true,
          method: 'oauth',
          displayName: 'Claude Pro/Max Account',
        };
      }

      if (config.apiKey) {
        return {
          isAuthenticated: true,
          method: 'api-key',
          displayName: 'API Key',
        };
      }

      return {
        isAuthenticated: false,
        method: 'none',
      };
    } catch (error) {
      logger.error('Failed to get auth status', { error });
      throw new AuthenticationError(formatErrorMessage('Failed to get authentication status', error), ERROR_CODES.AUTH_NOT_CONFIGURED, error);
    }
  });

  // The account behind the current login, so the user can check which one
  // the app is using. Null rather than an error when it cannot be read: the
  // settings panel says so, and nothing else depends on it.
  ipcMain.handle(IPC_CHANNELS.AUTH_GET_ACCOUNT, async (): Promise<ClaudeAccount | null> => {
    try {
      ensureService(claudeService, 'ClaudeCodeService');
      return await claudeService.getAccountInfo();
    } catch (error) {
      logger.warn('Failed to read the logged-in account', { error });
      return null;
    }
  });

  // Start OAuth login flow - returns URL for user to click
  ipcMain.handle(
    IPC_CHANNELS.AUTH_START_OAUTH,
    async (): Promise<{ authUrl: string; error?: string }> => {
      try {
        logger.info('IPC: auth:start-oauth');

        // Validate service
        ensureService(authService, 'AuthService');

        const result = await authService.startOAuthFlow();

        if (!result) {
          throw new AuthenticationError('OAuth flow initialization returned no result', ERROR_CODES.AUTH_OAUTH_FAILED);
        }

        if (result.authUrl) {
          // Open the URL in the user's browser
          authService.openAuthUrl(result.authUrl);
          logger.info('OAuth URL opened in browser');
        }

        return result;
      } catch (error) {
        logger.error('Failed to start OAuth flow', { error });
        return {
          authUrl: '',
          error: formatErrorMessage('Failed to start OAuth flow', error),
        };
      }
    }
  );

  // Complete OAuth flow with the code from browser
  ipcMain.handle(
    IPC_CHANNELS.AUTH_COMPLETE_OAUTH,
    async (_event, code: string): Promise<{ success: boolean; error?: string }> => {
      try {
        logger.info('IPC: auth:complete-oauth');

        // Validate services
        ensureService(authService, 'AuthService');
        ensureService(configService, 'ConfigService');

        // Validate input
        try {
          validateString(code, 'OAuth code');
        } catch {
          return { success: false, error: 'Please enter the code from your browser' };
        }

        const trimmedCode = code.trim();

        // Basic length validation only - let the CLI validate the actual format
        // OAuth codes can contain various characters depending on the provider
        if (trimmedCode.length < MAIN_CONSTANTS.AUTH.OAUTH_CODE_MIN_LENGTH || trimmedCode.length > MAIN_CONSTANTS.AUTH.OAUTH_CODE_MAX_LENGTH) {
          logger.warn('OAuth code length out of range', { codeLength: trimmedCode.length });
          return { success: false, error: 'Invalid code length. Please copy the complete code from your browser.' };
        }

        const result = await authService.completeOAuthFlow(trimmedCode);

        if (!result) {
          throw new AuthenticationError('OAuth completion returned no result', ERROR_CODES.AUTH_OAUTH_FAILED);
        }

        if (result.success && result.token) {
          // Validate token format before saving
          if (!result.token.startsWith('sk-ant-')) {
            logger.error('OAuth token has invalid format', { prefix: result.token.slice(0, 10) });
            return { success: false, error: 'Invalid token format received. Please try logging in again.' };
          }

          // Save the OAuth token
          const configUpdate = {
            oauthToken: result.token,
            authMethod: 'oauth' as const,
          };
          await configService.setConfig(configUpdate);

          // Verify the round-trip through safeStorage encryption/decryption succeeded
          try {
            const storedToken = await configService.getOAuthToken();
            if (!storedToken) {
              logger.error('OAuth token round-trip verification failed: token is empty after storage');
              return { success: false, error: 'Token storage failed. Please try logging in again.' };
            }
            if (storedToken !== result.token) {
              logger.error('OAuth token round-trip verification failed: stored token differs from original');
              await configService.setConfig({ oauthToken: '', authMethod: 'none' as const });
              return { success: false, error: 'Token storage verification failed. Please try logging in again.' };
            }
          } catch (err) {
            logger.error('OAuth token round-trip verification threw', { error: err });
            return { success: false, error: 'Failed to verify stored token. Your system keyring may not be working. Please try again.' };
          }

          // The full credentials, for the CLI to use and refresh, and the
          // account they are for, which is where the CLI reads the email and
          // plan from. Into the config directory sessions run with; the
          // encrypted copy only restores a lost file (see cliCredentials.ts).
          if (result.credentialsJson) {
            try {
              await configService.setOAuthCredentials(result.credentialsJson);
              writeCliCredentials(result.credentialsJson);
              if (result.accountJson) mergeOAuthAccount(result.accountJson);
              logger.info('OAuth credentials saved to the stable config dir', { hasAccount: !!result.accountJson });
            } catch (err) {
              logger.warn('Failed to store full OAuth credentials', { error: err });
            }
          }

          // Conversations that are already open run their own CLI
          // subprocess, each holding the credentials it was spawned with.
          // Without this they would go on using the previous login for the
          // rest of the session — the new token would only ever reach
          // conversations started after this point.
          claudeService.invalidateSessionAuth('login');

          // Notify renderer of config change so UI updates
          sendToRenderer(getMainWindow, IPC_CHANNELS.CONFIG_CHANGED, configUpdate);

          logger.info('OAuth token saved and verified successfully');
          return { success: true };
        }

        return { success: false, error: result.error || 'OAuth completion failed' };
      } catch (error) {
        logger.error('Failed to complete OAuth flow', { error });
        return {
          success: false,
          error: formatErrorMessage('Failed to complete OAuth flow', error),
        };
      }
    }
  );

  // Logout - clear all auth credentials
  // Abandon a login in progress. The CLI waits for its code indefinitely, so
  // without this a cancelled login left it running until the next attempt,
  // a logout, or the app quitting.
  ipcMain.handle(IPC_CHANNELS.AUTH_CANCEL_OAUTH, async (): Promise<void> => {
    ensureService(authService, 'AuthService');
    logger.info('IPC: auth:cancel-oauth');
    authService.cleanupOAuthFlow();
  });

  ipcMain.handle(IPC_CHANNELS.AUTH_LOGOUT, async (): Promise<void> => {
    try {
      logger.info('IPC: auth:logout');

      // Validate services
      ensureService(authService, 'AuthService');
      ensureService(configService, 'ConfigService');

      // Clear both OAuth token and API key
      const configUpdate = {
        oauthToken: '',
        apiKey: '',
        authMethod: 'none' as const,
      };
      await configService.setConfig(configUpdate);
      await configService.clearOAuthCredentials();

      // Clean up stable config dir credentials file
      try {
        removeCliCredentials();
        logger.debug('Cleaned up credentials file from stable config dir');
      } catch (err) {
        logger.debug('Failed to clean up credentials file', { error: err });
      }

      // Same reason as on login, and more pressing: a session left running
      // keeps a working token for an account the user has just signed out of.
      // An idle one is ended here; one mid-turn is replaced when that turn
      // ends. See invalidateSessionAuth.
      claudeService.invalidateSessionAuth('logout');

      // Notify renderer of config change so UI updates
      sendToRenderer(getMainWindow, IPC_CHANNELS.CONFIG_CHANGED, configUpdate);

      // Clean up any pending OAuth flows
      authService.cleanupOAuthFlow();

      logger.info('Logged out successfully');
    } catch (error) {
      logger.error('Failed to logout', { error });
      throw new AuthenticationError(formatErrorMessage('Failed to logout', error), ERROR_CODES.AUTH_NOT_CONFIGURED, error);
    }
  });

  logger.info('Auth IPC handlers registered');
}
