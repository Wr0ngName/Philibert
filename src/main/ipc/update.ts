/**
 * IPC handlers for auto-update
 */

import { ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../shared/types';
import { AppError } from '../errors';
import UpdateService from '../services/UpdateService';
import { ensureService, formatErrorMessage } from '../utils/ipc-helpers';
import logger from '../utils/logger';

export function setupUpdateIPC(updateService: UpdateService): void {
  // Check for updates
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async () => {
    try {
      logger.debug('IPC: update:check');

      // Validate service
      ensureService(updateService, 'UpdateService');

      const updateInfo = await updateService.checkForUpdates();

      // updateInfo can be null if no updates available, which is valid
      return updateInfo;
    } catch (error) {
      logger.error('Failed to check for updates', { error });
      throw new AppError(formatErrorMessage('Failed to check for updates', error), 'UPDATE_CHECK_FAILED', error);
    }
  });

  // Download update
  ipcMain.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, async () => {
    try {
      logger.debug('IPC: update:download');

      // Validate service
      ensureService(updateService, 'UpdateService');

      await updateService.downloadUpdate();
    } catch (error) {
      logger.error('Failed to download update', { error });
      throw new AppError(formatErrorMessage('Failed to download update', error), 'UPDATE_DOWNLOAD_FAILED', error);
    }
  });

  // Install update and restart
  ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, () => {
    try {
      logger.debug('IPC: update:install');

      // Validate service
      ensureService(updateService, 'UpdateService');

      return updateService.installUpdate();
    } catch (error) {
      logger.error('Failed to install update', { error });
      throw new AppError(formatErrorMessage('Failed to install update', error), 'UPDATE_INSTALL_FAILED', error);
    }
  });

  logger.info('Update IPC handlers registered');
}
