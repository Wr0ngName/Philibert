/**
 * Notification Service for native OS notifications
 *
 * Shows native desktop notifications when the application window is not focused.
 * Notifications are triggered for:
 * - Tool use permission requests
 * - Claude finishing: each turn and background task, or only once everything
 *   is done (see CompletionNotifications)
 * - Errors
 *
 * Clicking a notification focuses and brings the window to front.
 */

import { BrowserWindow, Notification } from 'electron';

import logger from '../utils/logger';

import type ConfigService from './ConfigService';

export class NotificationService {
  private configService: ConfigService;
  private getMainWindow: () => BrowserWindow | null;

  constructor(configService: ConfigService, getMainWindow: () => BrowserWindow | null) {
    this.configService = configService;
    this.getMainWindow = getMainWindow;

    logger.info('NotificationService initialized', {
      supported: Notification.isSupported(),
    });
  }

  /**
   * Show notification for a tool use permission request
   */
  showPermissionRequest(conversationId: string, toolName: string, description: string): void {
    this.showNotification(
      'Action Requires Approval',
      `${toolName}: ${description}`,
      conversationId
    );
  }

  /**
   * A turn ended. `tasksStillRunning` is how many of the conversation's
   * background tasks are still going: with any, Claude has only started the
   * work — a build, an agent — and in 'all-done' mode that is not news. It
   * is, once the turn answering the last of them ends.
   */
  async showTurnEnded(conversationId: string, tasksStillRunning: number): Promise<void> {
    const { completionNotifications } = await this.configService.getConfig();
    if (completionNotifications === 'each') {
      await this.showNotification('Claude has finished', 'Claude has finished replying.', conversationId);
      return;
    }
    if (tasksStillRunning > 0) {
      logger.debug('Completion notification held: background tasks still running', {
        conversationId, tasksStillRunning,
      });
      return;
    }
    await this.showNotification(
      'Claude has finished',
      'Claude has finished, and no background task is still running.',
      conversationId,
    );
  }

  /**
   * A background task ended. Only in 'each' mode: otherwise the turn that
   * answers it is what says the work is done.
   */
  async showTaskEnded(conversationId: string, description: string): Promise<void> {
    const { completionNotifications } = await this.configService.getConfig();
    if (completionNotifications !== 'each') return;
    await this.showNotification('Background task ended', description || 'A background task ended.', conversationId);
  }

  /**
   * Show notification when an error occurs
   */
  showError(conversationId: string, error: string): void {
    const truncated = error.length > 100 ? error.slice(0, 100) + '...' : error;
    this.showNotification(
      'Error',
      truncated,
      conversationId
    );
  }

  /**
   * Check whether a notification should be shown.
   * Returns false if:
   * - Notifications are disabled in config
   * - The window is currently focused
   * - Notifications are not supported on this platform
   */
  private async shouldShowNotification(): Promise<boolean> {
    // Check platform support
    if (!Notification.isSupported()) {
      logger.debug('Notifications not supported on this platform');
      return false;
    }

    // Check config
    const config = await this.configService.getConfig();
    if (!config.enableNotifications) {
      return false;
    }

    // Check window focus
    const window = this.getMainWindow();
    if (!window) {
      // No window means nothing to notify about
      return false;
    }

    if (window.isFocused()) {
      return false;
    }

    return true;
  }

  /**
   * Show a native OS notification and handle click to focus window
   */
  private async showNotification(title: string, body: string, conversationId: string): Promise<void> {
    try {
      if (!(await this.shouldShowNotification())) {
        return;
      }

      const notification = new Notification({
        title,
        body,
      });

      notification.on('click', () => {
        const window = this.getMainWindow();
        if (window) {
          if (window.isMinimized()) {
            window.restore();
          }
          window.focus();
        }
      });

      notification.show();

      logger.debug('Notification shown', { title, conversationId });
    } catch (error) {
      // Never let notification errors break the main flow
      logger.warn('Failed to show notification', { title, error });
    }
  }
}

export default NotificationService;
