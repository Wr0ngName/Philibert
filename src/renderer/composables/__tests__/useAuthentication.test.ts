/**
 * Tests for the useAuthentication composable.
 *
 * Tests cover:
 * - Initial state
 * - Refreshing auth status
 * - Starting OAuth flow
 * - Completing OAuth flow
 * - Saving API key
 * - Logout
 * - State reset
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { useAuthentication } from '../useAuthentication';

// Mock window.electron
const mockElectron = {
  auth: {
    getStatus: vi.fn(),
    startOAuth: vi.fn(),
    completeOAuth: vi.fn(),
    cancelOAuth: vi.fn(),
    logout: vi.fn(),
  },
  config: {
    set: vi.fn(),
  },
};

describe('useAuthentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set up window.electron mock
    (window as any).electron = mockElectron;

    // Default mock implementations
    mockElectron.auth.getStatus.mockResolvedValue({
      isAuthenticated: false,
      method: 'none',
    });
    mockElectron.auth.startOAuth.mockResolvedValue({ authUrl: 'https://auth.example.com' });
    mockElectron.auth.completeOAuth.mockResolvedValue({ success: true });
    mockElectron.auth.logout.mockResolvedValue(undefined);
    mockElectron.config.set.mockResolvedValue(undefined);
  });

  // ===========================================================================
  // Initial State
  // ===========================================================================
  describe('initial state', () => {
    it('should have default auth status', () => {
      const { authStatus } = useAuthentication();

      expect(authStatus.value).toEqual({
        isAuthenticated: false,
        method: 'none',
      });
    });

    it('should not be logging in initially', () => {
      const { isLoggingIn } = useAuthentication();

      expect(isLoggingIn.value).toBe(false);
    });

    it('should have no login error initially', () => {
      const { loginError } = useAuthentication();

      expect(loginError.value).toBe('');
    });

    it('should have empty OAuth code', () => {
      const { oauthCode } = useAuthentication();

      expect(oauthCode.value).toBe('');
    });

    it('should not show code input initially', () => {
      const { showCodeInput } = useAuthentication();

      expect(showCodeInput.value).toBe(false);
    });
  });

  // ===========================================================================
  // refreshAuthStatus
  // ===========================================================================
  describe('refreshAuthStatus', () => {
    it('should fetch auth status from main process', async () => {
      mockElectron.auth.getStatus.mockResolvedValue({
        isAuthenticated: true,
        method: 'oauth',
        displayName: 'Claude Pro Account',
      });

      const { refreshAuthStatus, authStatus } = useAuthentication();
      await refreshAuthStatus();

      expect(mockElectron.auth.getStatus).toHaveBeenCalled();
      expect(authStatus.value).toEqual({
        isAuthenticated: true,
        method: 'oauth',
        displayName: 'Claude Pro Account',
      });
    });

    it('should handle errors gracefully', async () => {
      mockElectron.auth.getStatus.mockRejectedValue(new Error('IPC error'));

      const { refreshAuthStatus, authStatus } = useAuthentication();
      await refreshAuthStatus();

      // Should not throw and should keep default state
      expect(authStatus.value.isAuthenticated).toBe(false);
    });
  });

  // ===========================================================================
  // startOAuthLogin
  // ===========================================================================
  describe('startOAuthLogin', () => {
    it('should start OAuth flow', async () => {
      const { startOAuthLogin } = useAuthentication();
      await startOAuthLogin();

      expect(mockElectron.auth.startOAuth).toHaveBeenCalled();
    });

    it('should show code input when URL is returned', async () => {
      const { startOAuthLogin, showCodeInput } = useAuthentication();
      await startOAuthLogin();

      expect(showCodeInput.value).toBe(true);
    });

    it('should set isLoggingIn during request', async () => {
      const { startOAuthLogin, isLoggingIn } = useAuthentication();

      let isLoggingInDuringRequest = false;
      mockElectron.auth.startOAuth.mockImplementation(async () => {
        isLoggingInDuringRequest = isLoggingIn.value;
        return { authUrl: 'https://auth.example.com' };
      });

      await startOAuthLogin();

      expect(isLoggingInDuringRequest).toBe(true);
      expect(isLoggingIn.value).toBe(false);
    });

    it('should clear previous error and code', async () => {
      const { startOAuthLogin, loginError, oauthCode } = useAuthentication();
      loginError.value = 'Previous error';
      oauthCode.value = 'old_code';

      await startOAuthLogin();

      expect(loginError.value).toBe('');
      expect(oauthCode.value).toBe('');
    });

    it('should set error when OAuth returns error', async () => {
      mockElectron.auth.startOAuth.mockResolvedValue({
        authUrl: '',
        error: 'CLI not found',
      });

      const { startOAuthLogin, loginError, isLoggingIn } = useAuthentication();
      await startOAuthLogin();

      expect(loginError.value).toBe('CLI not found');
      expect(isLoggingIn.value).toBe(false);
    });

    it('should set error when request fails', async () => {
      mockElectron.auth.startOAuth.mockRejectedValue(new Error('Network error'));

      const { startOAuthLogin, loginError, isLoggingIn } = useAuthentication();
      await startOAuthLogin();

      expect(loginError.value).toContain('Failed to start login');
      expect(isLoggingIn.value).toBe(false);
    });
  });

  // ===========================================================================
  // completeOAuthLogin
  // ===========================================================================
  describe('completeOAuthLogin', () => {
    it('should complete OAuth with code', async () => {
      const { completeOAuthLogin, oauthCode } = useAuthentication();
      oauthCode.value = 'valid_code_12345';

      await completeOAuthLogin();

      expect(mockElectron.auth.completeOAuth).toHaveBeenCalledWith('valid_code_12345');
    });

    it('should refresh auth status on success', async () => {
      mockElectron.auth.completeOAuth.mockResolvedValue({ success: true });
      mockElectron.auth.getStatus.mockResolvedValue({
        isAuthenticated: true,
        method: 'oauth',
      });

      const { completeOAuthLogin, oauthCode, authStatus } = useAuthentication();
      oauthCode.value = 'valid_code_12345';

      await completeOAuthLogin();

      expect(mockElectron.auth.getStatus).toHaveBeenCalled();
      expect(authStatus.value.isAuthenticated).toBe(true);
    });

    it('should clear code and hide input on success', async () => {
      mockElectron.auth.completeOAuth.mockResolvedValue({ success: true });

      const { completeOAuthLogin, oauthCode, showCodeInput } = useAuthentication();
      oauthCode.value = 'valid_code';
      showCodeInput.value = true;

      await completeOAuthLogin();

      expect(oauthCode.value).toBe('');
      expect(showCodeInput.value).toBe(false);
    });

    it('should call onAuthenticated callback on success', async () => {
      mockElectron.auth.completeOAuth.mockResolvedValue({ success: true });

      const onAuthenticated = vi.fn();
      const { completeOAuthLogin, oauthCode } = useAuthentication({ onAuthenticated });
      oauthCode.value = 'valid_code';

      await completeOAuthLogin();

      expect(onAuthenticated).toHaveBeenCalled();
    });

    it('should set error when code is empty', async () => {
      const { completeOAuthLogin, oauthCode, loginError } = useAuthentication();
      oauthCode.value = '';

      await completeOAuthLogin();

      expect(mockElectron.auth.completeOAuth).not.toHaveBeenCalled();
      expect(loginError.value).toBe('Please enter the code from your browser');
    });

    it('should set error when code is whitespace', async () => {
      const { completeOAuthLogin, oauthCode, loginError } = useAuthentication();
      oauthCode.value = '   ';

      await completeOAuthLogin();

      expect(mockElectron.auth.completeOAuth).not.toHaveBeenCalled();
      expect(loginError.value).toBe('Please enter the code from your browser');
    });

    it('should set error when completion fails', async () => {
      mockElectron.auth.completeOAuth.mockResolvedValue({
        success: false,
        error: 'Invalid code',
      });

      const { completeOAuthLogin, oauthCode, loginError } = useAuthentication();
      oauthCode.value = 'invalid_code';

      await completeOAuthLogin();

      expect(loginError.value).toBe('Invalid code');
    });

    it('should handle request error', async () => {
      mockElectron.auth.completeOAuth.mockRejectedValue(new Error('Network error'));

      const { completeOAuthLogin, oauthCode, loginError, isLoggingIn } = useAuthentication();
      oauthCode.value = 'valid_code';

      await completeOAuthLogin();

      expect(loginError.value).toContain('Login failed');
      expect(isLoggingIn.value).toBe(false);
    });

    it('should trim code before sending', async () => {
      const { completeOAuthLogin, oauthCode } = useAuthentication();
      oauthCode.value = '  valid_code  ';

      await completeOAuthLogin();

      expect(mockElectron.auth.completeOAuth).toHaveBeenCalledWith('valid_code');
    });
  });

  // ===========================================================================
  // saveApiKey
  // ===========================================================================
  describe('saveApiKey', () => {
    it('should save API key to config', async () => {
      const { saveApiKey } = useAuthentication();
      await saveApiKey('sk-ant-api-key');

      expect(mockElectron.config.set).toHaveBeenCalledWith({
        apiKey: 'sk-ant-api-key',
        authMethod: 'api-key',
      });
    });

    it('should refresh auth status after saving', async () => {
      mockElectron.auth.getStatus.mockResolvedValue({
        isAuthenticated: true,
        method: 'api-key',
      });

      const { saveApiKey, authStatus } = useAuthentication();
      await saveApiKey('sk-ant-api-key');

      expect(mockElectron.auth.getStatus).toHaveBeenCalled();
      expect(authStatus.value.isAuthenticated).toBe(true);
    });

    it('should call onAuthenticated callback', async () => {
      const onAuthenticated = vi.fn();
      const { saveApiKey } = useAuthentication({ onAuthenticated });

      await saveApiKey('sk-ant-api-key');

      expect(onAuthenticated).toHaveBeenCalled();
    });

    it('should set error when API key is empty', async () => {
      const { saveApiKey, loginError } = useAuthentication();
      await saveApiKey('');

      expect(mockElectron.config.set).not.toHaveBeenCalled();
      expect(loginError.value).toBe('Please enter your API key');
    });

    it('should set error when API key is whitespace', async () => {
      const { saveApiKey, loginError } = useAuthentication();
      await saveApiKey('   ');

      expect(mockElectron.config.set).not.toHaveBeenCalled();
      expect(loginError.value).toBe('Please enter your API key');
    });

    it('should propagate save errors', async () => {
      mockElectron.config.set.mockRejectedValue(new Error('Storage error'));

      const { saveApiKey, loginError, isLoggingIn } = useAuthentication();

      await expect(saveApiKey('sk-ant-api-key')).rejects.toThrow();
      expect(loginError.value).toContain('Failed to save API key');
      expect(isLoggingIn.value).toBe(false);
    });

    it('should trim API key before saving', async () => {
      const { saveApiKey } = useAuthentication();
      await saveApiKey('  sk-ant-api-key  ');

      expect(mockElectron.config.set).toHaveBeenCalledWith({
        apiKey: 'sk-ant-api-key',
        authMethod: 'api-key',
      });
    });
  });

  // ===========================================================================
  // logout
  // ===========================================================================
  describe('logout', () => {
    it('should call logout on main process', async () => {
      const { logout } = useAuthentication();
      await logout();

      expect(mockElectron.auth.logout).toHaveBeenCalled();
    });

    it('should refresh auth status after logout', async () => {
      mockElectron.auth.getStatus
        .mockResolvedValueOnce({ isAuthenticated: true, method: 'oauth' })
        .mockResolvedValueOnce({ isAuthenticated: false, method: 'none' });

      const { logout, authStatus, refreshAuthStatus } = useAuthentication();
      await refreshAuthStatus();
      expect(authStatus.value.isAuthenticated).toBe(true);

      await logout();

      expect(authStatus.value.isAuthenticated).toBe(false);
    });

    it('should propagate logout errors', async () => {
      mockElectron.auth.logout.mockRejectedValue(new Error('Logout failed'));

      const { logout } = useAuthentication();

      await expect(logout()).rejects.toThrow('Logout failed');
    });
  });

  // ===========================================================================
  // resetState
  // ===========================================================================
  describe('resetState', () => {
    it('should reset all form state', () => {
      const { showCodeInput, oauthCode, loginError, isLoggingIn, resetState } = useAuthentication();

      // Set some state
      showCodeInput.value = true;
      oauthCode.value = 'some_code';
      loginError.value = 'Some error';
      isLoggingIn.value = true;

      resetState();

      expect(showCodeInput.value).toBe(false);
      expect(oauthCode.value).toBe('');
      expect(loginError.value).toBe('');
      expect(isLoggingIn.value).toBe(false);
    });

    it('abandons a login waiting for its code, so its CLI process ends', () => {
      const { showCodeInput, resetState } = useAuthentication();
      showCodeInput.value = true;

      resetState();

      expect(mockElectron.auth.cancelOAuth).toHaveBeenCalledTimes(1);
    });

    it('has nothing to abandon when no login is waiting', () => {
      const { resetState } = useAuthentication();

      resetState();

      expect(mockElectron.auth.cancelOAuth).not.toHaveBeenCalled();
    });
  });

  describe('cancelOAuthLogin', () => {
    it('ends the login in the main process and closes the code step', async () => {
      const { showCodeInput, oauthCode, cancelOAuthLogin } = useAuthentication();
      showCodeInput.value = true;
      oauthCode.value = 'half-typed';
      mockElectron.auth.cancelOAuth.mockResolvedValue(undefined);

      await cancelOAuthLogin();

      expect(mockElectron.auth.cancelOAuth).toHaveBeenCalledTimes(1);
      expect(showCodeInput.value).toBe(false);
      expect(oauthCode.value).toBe('');
    });
  });
});
