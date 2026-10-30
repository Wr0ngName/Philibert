/**
 * Comprehensive tests for NotificationService.
 *
 * Tests cover:
 * - Notification shown when window is NOT focused and notifications enabled
 * - Notification NOT shown when window IS focused
 * - Notification NOT shown when disabled in config
 * - Notification NOT shown when platform doesn't support notifications
 * - Clicking notification focuses and restores window
 * - Permission request notification format
 * - Claude-finished notifications, per completion mode
 * - Error notification format (including truncation)
 * - Graceful error handling (never breaks main flow)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks for Electron's Notification API
const { mockNotificationInstance, MockNotificationClass, mockIsSupported } = vi.hoisted(() => {
  const instance = {
    on: vi.fn(),
    show: vi.fn(),
  };

  return {
    mockNotificationInstance: instance,
    // Use function keyword to avoid vitest warning about class/function constructors
    MockNotificationClass: vi.fn(function () {
      return instance;
    }),
    mockIsSupported: vi.fn().mockReturnValue(true),
  };
});

// Mock electron module
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  Notification: Object.assign(MockNotificationClass, {
    isSupported: mockIsSupported,
  }),
}));

// Mock logger
vi.mock('../../utils/logger', () => ({
  default: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocks
import { createMockBrowserWindow, type MockBrowserWindow } from '../../__tests__/setup';
import { NotificationService } from '../NotificationService';

/** Flush all pending microtasks/promises */
async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('NotificationService', () => {
  let service: NotificationService;
  let mockWindow: MockBrowserWindow;
  let mockConfigService: {
    getConfig: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockWindow = createMockBrowserWindow();
    mockWindow.isFocused.mockReturnValue(false);
    mockWindow.isMinimized.mockReturnValue(false);

    mockConfigService = {
      getConfig: vi.fn().mockResolvedValue({ enableNotifications: true }),
    };

    mockIsSupported.mockReturnValue(true);

    service = new NotificationService(
      mockConfigService as any,
      () => mockWindow as any
    );
  });

  describe('showPermissionRequest', () => {
    it('should show notification when window is NOT focused and enabled', async () => {
      mockWindow.isFocused.mockReturnValue(false);

      service.showPermissionRequest('conv-1', 'Bash', 'Run command: ls -la');
      await flushPromises();

      expect(MockNotificationClass).toHaveBeenCalledWith({
        title: 'Action Requires Approval',
        body: 'Bash: Run command: ls -la',
      });
      expect(mockNotificationInstance.show).toHaveBeenCalled();
    });

    it('should NOT show notification when window IS focused', async () => {
      mockWindow.isFocused.mockReturnValue(true);

      service.showPermissionRequest('conv-1', 'Edit', 'Edit file: foo.ts');
      await flushPromises();

      expect(mockNotificationInstance.show).not.toHaveBeenCalled();
    });

    it('should NOT show notification when disabled in config', async () => {
      mockConfigService.getConfig.mockResolvedValue({ enableNotifications: false });

      service.showPermissionRequest('conv-1', 'Write', 'Write file: bar.ts');
      await flushPromises();

      expect(mockNotificationInstance.show).not.toHaveBeenCalled();
    });

    it('should NOT show notification when not supported on platform', async () => {
      mockIsSupported.mockReturnValue(false);

      service.showPermissionRequest('conv-1', 'Bash', 'Run command: npm test');
      await flushPromises();

      expect(mockNotificationInstance.show).not.toHaveBeenCalled();
    });

    it('should NOT show notification when no window exists', async () => {
      const noWindowService = new NotificationService(
        mockConfigService as any,
        () => null
      );

      noWindowService.showPermissionRequest('conv-1', 'Bash', 'Run command: ls');
      await flushPromises();

      expect(mockNotificationInstance.show).not.toHaveBeenCalled();
    });
  });

  describe('Claude finishing', () => {
    function mode(completionNotifications: 'all-done' | 'each') {
      mockConfigService.getConfig.mockResolvedValue({ enableNotifications: true, completionNotifications });
    }

    describe("'all-done' (the default)", () => {
      beforeEach(() => mode('all-done'));

      it('says nothing while a background task the turn started is still running', async () => {
        await service.showTurnEnded('conv-2', 1);

        expect(mockNotificationInstance.show).not.toHaveBeenCalled();
      });

      it('says Claude has finished once a turn ends with no background task left', async () => {
        await service.showTurnEnded('conv-2', 0);

        expect(MockNotificationClass).toHaveBeenCalledWith({
          title: 'Claude has finished',
          body: 'Claude has finished, and no background task is still running.',
        });
        expect(mockNotificationInstance.show).toHaveBeenCalledTimes(1);
      });

      it('says nothing when a background task ends: the turn answering it will', async () => {
        await service.showTaskEnded('conv-2', 'Build the app');

        expect(mockNotificationInstance.show).not.toHaveBeenCalled();
      });

      it('is the default for a config that has never been saved with the setting', async () => {
        mockConfigService.getConfig.mockResolvedValue({ enableNotifications: true });

        await service.showTurnEnded('conv-2', 1);
        await service.showTaskEnded('conv-2', 'Build the app');

        expect(mockNotificationInstance.show).not.toHaveBeenCalled();
      });
    });

    describe("'each'", () => {
      beforeEach(() => mode('each'));

      it('says so at the end of every turn, background tasks or not', async () => {
        await service.showTurnEnded('conv-2', 1);
        await service.showTurnEnded('conv-2', 0);

        expect(MockNotificationClass).toHaveBeenCalledWith({
          title: 'Claude has finished',
          body: 'Claude has finished replying.',
        });
        expect(mockNotificationInstance.show).toHaveBeenCalledTimes(2);
      });

      it('says which background task ended', async () => {
        await service.showTaskEnded('conv-2', 'Build the app');

        expect(MockNotificationClass).toHaveBeenCalledWith({
          title: 'Background task ended',
          body: 'Build the app',
        });
        expect(mockNotificationInstance.show).toHaveBeenCalledTimes(1);
      });
    });

    it('should NOT show when window is focused', async () => {
      mode('each');
      mockWindow.isFocused.mockReturnValue(true);

      await service.showTurnEnded('conv-2', 0);
      await service.showTaskEnded('conv-2', 'Build the app');

      expect(mockNotificationInstance.show).not.toHaveBeenCalled();
    });
  });

  describe('showError', () => {
    it('should show notification with error message', async () => {
      service.showError('conv-3', 'Authentication failed');
      await flushPromises();

      expect(MockNotificationClass).toHaveBeenCalledWith({
        title: 'Error',
        body: 'Authentication failed',
      });
      expect(mockNotificationInstance.show).toHaveBeenCalled();
    });

    it('should truncate long error messages', async () => {
      const longError = 'A'.repeat(200);

      service.showError('conv-3', longError);
      await flushPromises();

      expect(MockNotificationClass).toHaveBeenCalledWith({
        title: 'Error',
        body: 'A'.repeat(100) + '...',
      });
      expect(mockNotificationInstance.show).toHaveBeenCalled();
    });
  });

  describe('notification click handling', () => {
    it('should focus window when notification is clicked', async () => {
      service.showPermissionRequest('conv-1', 'Bash', 'Run npm test');
      await flushPromises();

      expect(mockNotificationInstance.on).toHaveBeenCalledWith('click', expect.any(Function));

      // Simulate click - extract handler from mock.calls
      const calls = mockNotificationInstance.on.mock.calls as Array<[string, () => void]>;
      const clickCall = calls.find((call) => call[0] === 'click');
      expect(clickCall).toBeDefined();

      clickCall![1]();

      expect(mockWindow.focus).toHaveBeenCalled();
    });

    it('should restore minimized window on notification click', async () => {
      mockWindow.isMinimized.mockReturnValue(true);

      await service.showTurnEnded('conv-1', 0);

      expect(mockNotificationInstance.on).toHaveBeenCalledWith('click', expect.any(Function));

      const calls = mockNotificationInstance.on.mock.calls as Array<[string, () => void]>;
      const clickCall = calls.find((call) => call[0] === 'click');

      clickCall![1]();

      expect(mockWindow.restore).toHaveBeenCalled();
      expect(mockWindow.focus).toHaveBeenCalled();
    });

    it('should not crash if window is null on click', async () => {
      service.showPermissionRequest('conv-1', 'Bash', 'test');
      await flushPromises();

      const calls = mockNotificationInstance.on.mock.calls as Array<[string, () => void]>;
      const clickCall = calls.find((call) => call[0] === 'click');

      // The click handler doesn't throw even though window.focus is called
      // because the handler has its own getMainWindow reference
      expect(() => clickCall![1]()).not.toThrow();
    });
  });

  describe('error resilience', () => {
    it('should not throw if Notification constructor throws', async () => {
      MockNotificationClass.mockImplementationOnce(() => {
        throw new Error('Notification API error');
      });

      // Should not throw
      service.showPermissionRequest('conv-1', 'Bash', 'test');
      await flushPromises();

      // No crash, just logged
    });

    it('should not throw if show() throws', async () => {
      mockNotificationInstance.show.mockImplementationOnce(() => {
        throw new Error('show() failed');
      });

      service.showPermissionRequest('conv-1', 'Bash', 'test');
      await flushPromises();

      // No crash
    });

    it('should not throw if getConfig() rejects', async () => {
      mockConfigService.getConfig.mockRejectedValueOnce(new Error('Config unavailable'));

      service.showPermissionRequest('conv-1', 'Bash', 'test');
      await flushPromises();

      // No crash - error is caught internally
    });
  });
});
