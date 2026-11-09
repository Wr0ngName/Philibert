/**
 * IPC handlers for file system operations
 */

import { dialog, ipcMain, shell, BrowserWindow } from 'electron';

import { IPC_CHANNELS } from '../../shared/types';
import { FileSystemError, ERROR_CODES } from '../errors';
import ConfigService from '../services/ConfigService';
import FileWatcherService from '../services/FileWatcherService';
import { readLocalImage } from '../services/LocalImageReader';
import { validateString, validatePath, sendToRenderer, ensureService, formatErrorMessage } from '../utils/ipc-helpers';
import logger from '../utils/logger';
import { isPathWithin, normalizePath } from '../utils/paths';

export function setupFilesIPC(
  fileWatcher: FileWatcherService,
  configService: ConfigService,
  getMainWindow: () => BrowserWindow | null
): void {
  /**
   * Why `target` may not be handed to the system — no working directory, or
   * a path outside it — or null when it may. A path inside the working
   * directory, not one merely starting with its name: a plain prefix check
   * let `/home/u/proj2/x` through for a working directory of `/home/u/proj`.
   */
  async function outsideWorkingDirectory(target: string): Promise<string | null> {
    const workingDir = await configService.getWorkingDirectory();
    if (!workingDir) return 'No working directory set';
    if (!isPathWithin(normalizePath(target), normalizePath(workingDir))) return 'File is outside working directory';
    return null;
  }

  // Select working directory
  ipcMain.handle(IPC_CHANNELS.FILES_SELECT_DIR, async () => {
    try {
      // Validate services
      ensureService(fileWatcher, 'FileWatcherService');
      ensureService(configService, 'ConfigService');

      const mainWindow = getMainWindow();
      if (!mainWindow) {
        logger.warn('No main window available for directory selection');
        return null;
      }

      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Working Directory',
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Select',
      });

      if (result.canceled || result.filePaths.length === 0) {
        logger.debug('Directory selection cancelled');
        return null;
      }

      const selectedDir = result.filePaths[0];

      validateString(selectedDir, 'Selected directory path');

      // Save to config. A new working directory retargets the watchers
      // through configService.onWorkingDirectoryChange (see index.ts); a
      // second watch here walked the whole folder again, and froze the
      // window twice as long.
      await configService.setWorkingDirectory(selectedDir);

      logger.info('Working directory selected', { directory: selectedDir });
      return selectedDir;
    } catch (error) {
      logger.error('Failed to select directory', { error });
      throw new FileSystemError(formatErrorMessage('Failed to select directory', error), undefined, ERROR_CODES.FS_READ_FAILED, error);
    }
  });

  // One directory of the working directory, one level deep
  ipcMain.handle(IPC_CHANNELS.FILES_LIST_DIRECTORY, async (_event, directory: string, workingDirectory: string) => {
    try {
      logger.debug('IPC: files:list-directory', { directory });

      // Validate service
      ensureService(fileWatcher, 'FileWatcherService');

      // Validate input
      validateString(directory, 'Directory path');
      validatePath(directory);
      validateString(workingDirectory, 'Working directory');
      validatePath(workingDirectory);

      return await fileWatcher.listDirectory(directory, workingDirectory);
    } catch (error) {
      logger.error('Failed to list directory', { error, directory });
      throw new FileSystemError(formatErrorMessage('Failed to list directory', error), directory, ERROR_CODES.FS_READ_FAILED, error);
    }
  });

  // Read file content
  ipcMain.handle(IPC_CHANNELS.FILES_READ, async (_event, filePath: string) => {
    try {
      logger.debug('IPC: files:read', { filePath });

      // Validate services
      ensureService(fileWatcher, 'FileWatcherService');
      ensureService(configService, 'ConfigService');

      // Validate input
      validateString(filePath, 'File path');
      validatePath(filePath);

      const workingDir = await configService.getWorkingDirectory();
      if (!workingDir) {
        throw new FileSystemError('No working directory set', undefined, ERROR_CODES.FS_PATH_TRAVERSAL);
      }

      const content = await fileWatcher.readFile(filePath, workingDir);

      if (content === undefined || content === null) {
        throw new FileSystemError('Failed to read file content', filePath, ERROR_CODES.FS_READ_FAILED);
      }

      return content;
    } catch (error) {
      logger.error('Failed to read file', { error, filePath });
      throw new FileSystemError(formatErrorMessage('Failed to read file', error), filePath, ERROR_CODES.FS_READ_FAILED, error);
    }
  });

  // Read an image a message points at by path. Not confined to the working
  // directory, and only ever answers with an image — see LocalImageReader.
  ipcMain.handle(
    IPC_CHANNELS.FILES_READ_IMAGE,
    async (_event, reference: string, baseDir: string | null) => {
      try {
        validateString(reference, 'Image reference');
        if (baseDir !== null) validateString(baseDir, 'Base directory');
        return await readLocalImage(reference, baseDir);
      } catch (error) {
        logger.error('Failed to read a referenced image', { error, reference });
        throw new FileSystemError(
          formatErrorMessage('Failed to read the image', error),
          reference,
          ERROR_CODES.FS_READ_FAILED,
          error,
        );
      }
    },
  );

  // Open file in system's default application
  ipcMain.handle(IPC_CHANNELS.FILES_OPEN, async (_event, filePath: string) => {
    try {
      logger.debug('IPC: files:open', { filePath });

      ensureService(configService, 'ConfigService');

      validateString(filePath, 'File path');
      validatePath(filePath);

      const refused = await outsideWorkingDirectory(filePath);
      if (refused) return { success: false, error: refused };

      const errorMessage = await shell.openPath(filePath);
      if (errorMessage) {
        logger.warn('Failed to open file', { filePath, error: errorMessage });
        return { success: false, error: errorMessage };
      }

      logger.info('Opened file in system application', { filePath });
      return { success: true };
    } catch (error) {
      logger.error('Failed to open file', { error, filePath });
      return { success: false, error: formatErrorMessage('Failed to open file', error) };
    }
  });

  // Show a file or folder selected in the system's file manager
  ipcMain.handle(IPC_CHANNELS.FILES_SHOW_IN_FOLDER, async (_event, target: string) => {
    try {
      logger.debug('IPC: files:show-in-folder', { target });

      ensureService(configService, 'ConfigService');
      validateString(target, 'Path');
      validatePath(target);

      const refused = await outsideWorkingDirectory(target);
      if (refused) return { success: false, error: refused };

      shell.showItemInFolder(target);
      return { success: true };
    } catch (error) {
      logger.error('Failed to show in folder', { error, target });
      return { success: false, error: formatErrorMessage('Failed to show in folder', error) };
    }
  });

  // Set up file change notifications
  try {
    ensureService(fileWatcher, 'FileWatcherService');

    fileWatcher.onChange((changes) => {
      try {
        if (!changes || !Array.isArray(changes)) {
          logger.warn('Invalid file changes received', { changes });
          return;
        }

        sendToRenderer(getMainWindow, IPC_CHANNELS.FILES_CHANGED, changes);
      } catch (error) {
        logger.error('Failed to send file change notification', { error });
      }
    });
  } catch (error) {
    logger.error('Failed to setup file change notifications', { error });
  }

  logger.info('Files IPC handlers registered');
}
