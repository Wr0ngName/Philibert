/**
 * Authentication composable - handles OAuth and API key authentication
 */

import { ref } from 'vue';

import type { AuthStatus, ClaudeAccount } from '@shared/types';

import { logger } from '../utils/logger';

export interface UseAuthenticationOptions {
  /**
   * Callback to execute after successful authentication
   */
  onAuthenticated?: () => void;
}

export function useAuthentication(options: UseAuthenticationOptions = {}) {
  // State
  const authStatus = ref<AuthStatus>({ isAuthenticated: false, method: 'none' });
  const isLoggingIn = ref(false);
  const loginError = ref('');
  const oauthCode = ref('');
  const showCodeInput = ref(false);
  /** The account behind an OAuth login, once read. */
  const account = ref<ClaudeAccount | null>(null);
  /**
   * Where reading it stands. 'unavailable' is said out loud in the form:
   * the point of showing the account is that the user can check it, and a
   * blank where it should be would look like there is nothing to check.
   */
  const accountState = ref<'none' | 'loading' | 'loaded' | 'token-only' | 'unavailable'>('none');
  /** Bumped per read, so a slow answer for an earlier login is dropped. */
  let accountRead = 0;

  /**
   * Fetch current authentication status from main process
   */
  async function refreshAuthStatus() {
    try {
      authStatus.value = await window.electron.auth.getStatus();
    } catch (err) {
      logger.error('Failed to get auth status', err);
    }
    void refreshAccount();
  }

  /**
   * Read the account behind the login. Only an OAuth login has one with an
   * email to show; an API key does not.
   */
  async function refreshAccount() {
    const read = ++accountRead;
    account.value = null;
    if (!authStatus.value.isAuthenticated || authStatus.value.method !== 'oauth') {
      accountState.value = 'none';
      return;
    }
    accountState.value = 'loading';
    let result: ClaudeAccount | null = null;
    try {
      result = await window.electron.auth.getAccount();
    } catch (err) {
      logger.warn('Failed to read the logged-in account', { error: err });
    }
    if (read !== accountRead) return;
    account.value = result;
    accountState.value = result?.email ? 'loaded' : result?.tokenOnly ? 'token-only' : 'unavailable';
  }

  /**
   * Start OAuth login flow - opens browser for authentication
   */
  async function startOAuthLogin() {
    isLoggingIn.value = true;
    loginError.value = '';
    oauthCode.value = '';

    try {
      const result = await window.electron.auth.startOAuth();

      if (result.error) {
        loginError.value = result.error;
        isLoggingIn.value = false;
        return;
      }

      if (result.authUrl) {
        // URL opened in browser, show code input
        showCodeInput.value = true;
        isLoggingIn.value = false;
      }
    } catch (error) {
      loginError.value = `Failed to start login: ${error}`;
      isLoggingIn.value = false;
    }
  }

  /**
   * Complete OAuth login with the code from browser
   */
  async function completeOAuthLogin() {
    if (!oauthCode.value.trim()) {
      loginError.value = 'Please enter the code from your browser';
      return;
    }

    isLoggingIn.value = true;
    loginError.value = '';

    try {
      const result = await window.electron.auth.completeOAuth(oauthCode.value.trim());

      if (result.success) {
        await refreshAuthStatus();
        showCodeInput.value = false;
        oauthCode.value = '';
        options.onAuthenticated?.();
      } else {
        loginError.value = result.error || 'Login failed';
      }
    } catch (error) {
      loginError.value = `Login failed: ${error}`;
    } finally {
      isLoggingIn.value = false;
    }
  }

  /**
   * Save API key for authentication
   */
  async function saveApiKey(apiKey: string) {
    if (!apiKey.trim()) {
      loginError.value = 'Please enter your API key';
      return;
    }

    isLoggingIn.value = true;
    loginError.value = '';

    try {
      await window.electron.config.set({
        apiKey: apiKey.trim(),
        authMethod: 'api-key',
      });
      await refreshAuthStatus();
      options.onAuthenticated?.();
    } catch (error) {
      loginError.value = `Failed to save API key: ${error}`;
      throw error;
    } finally {
      isLoggingIn.value = false;
    }
  }

  /**
   * Logout from current authentication method
   */
  async function logout() {
    try {
      await window.electron.auth.logout();
      await refreshAuthStatus();
    } catch (err) {
      logger.error('Logout failed', err);
      throw err;
    }
  }

  /**
   * Reset the authentication form state
   */
  function resetState() {
    // A login waiting for its code is abandoned with the form, or its CLI
    // process would go on waiting with nothing left to answer it.
    if (showCodeInput.value) void cancelOAuthLogin();
    showCodeInput.value = false;
    oauthCode.value = '';
    loginError.value = '';
    isLoggingIn.value = false;
  }

  /** Abandon the login waiting for its code. */
  async function cancelOAuthLogin() {
    showCodeInput.value = false;
    oauthCode.value = '';
    try {
      await window.electron.auth.cancelOAuth();
    } catch (err) {
      logger.warn('Failed to cancel the login in progress', { error: err });
    }
  }

  return {
    // State
    authStatus,
    isLoggingIn,
    loginError,
    oauthCode,
    showCodeInput,
    account,
    accountState,

    // Methods
    refreshAuthStatus,
    startOAuthLogin,
    completeOAuthLogin,
    cancelOAuthLogin,
    saveApiKey,
    logout,
    resetState,
  };
}
