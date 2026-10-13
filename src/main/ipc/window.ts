/**
 * IPC handlers for window operations
 */

import { clipboard, ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../shared/types';
import logger from '../utils/logger';
import { closeWindow, maximizeWindow, minimizeWindow } from '../window';

export function setupWindowIPC(): void {
  ipcMain.on(IPC_CHANNELS.WINDOW_MINIMIZE, () => {
    try {
      logger.debug('IPC: window:minimize');
      minimizeWindow();
    } catch (error) {
      logger.error('Failed to minimize window', { error });
      // Don't throw for window operations as they use ipcMain.on (not handle)
    }
  });

  ipcMain.on(IPC_CHANNELS.WINDOW_MAXIMIZE, () => {
    try {
      logger.debug('IPC: window:maximize');
      maximizeWindow();
    } catch (error) {
      logger.error('Failed to maximize window', { error });
      // Don't throw for window operations as they use ipcMain.on (not handle)
    }
  });

  ipcMain.on(IPC_CHANNELS.WINDOW_CLOSE, () => {
    try {
      logger.debug('IPC: window:close');
      closeWindow();
    } catch (error) {
      logger.error('Failed to close window', { error });
      // Don't throw for window operations as they use ipcMain.on (not handle)
    }
  });

  // Clipboard writes go through here rather than `navigator.clipboard`: that
  // one is subject to Chromium's permission and focus gates, and this window's
  // permission handler denies everything except media — so a refused write
  // looked exactly like a menu item that does nothing, which is how it was
  // reported. `handle` rather than `on`, so a failure can reach the caller
  // instead of vanishing.
  ipcMain.handle(IPC_CHANNELS.CLIPBOARD_WRITE_TEXT, (_event, text: string) => {
    logger.debug('IPC: clipboard:write-text', { length: text?.length ?? 0 });
    clipboard.writeText(typeof text === 'string' ? text : String(text));
  });

  logger.info('Window IPC handlers registered');
}
