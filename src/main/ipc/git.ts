/**
 * IPC handlers for git operations
 */

import { BrowserWindow, ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../shared/types';
import ConfigService from '../services/ConfigService';
import FileWatcherService from '../services/FileWatcherService';
import GitService from '../services/GitService';
import { validateString, sendToRenderer, ensureService, formatErrorMessage } from '../utils/ipc-helpers';
import logger from '../utils/logger';

export function setupGitIPC(
  gitService: GitService,
  configService: ConfigService,
  fileWatcher: FileWatcherService,
  getMainWindow: () => BrowserWindow | null
): void {
  // Get git status
  ipcMain.handle(IPC_CHANNELS.GIT_STATUS, async (_event, workingDir: string) => {
    try {
      ensureService(gitService, 'GitService');
      validateString(workingDir, 'Working directory');

      return await gitService.getStatus(workingDir);
    } catch (error) {
      logger.error('Failed to get git status', { error, workingDir });
      throw new Error(formatErrorMessage('Failed to get git status', error), { cause: error });
    }
  });

  // Commit changes
  ipcMain.handle(
    IPC_CHANNELS.GIT_COMMIT,
    async (
      _event,
      workingDir: string,
      message: string,
      stageAll: boolean,
      expectedBranch?: string
    ) => {
      try {
        ensureService(gitService, 'GitService');
        validateString(workingDir, 'Working directory');
        validateString(message, 'Commit message');

        return await gitService.commit(workingDir, message, stageAll, expectedBranch);
      } catch (error) {
        logger.error('Failed to commit', { error, workingDir });
        throw new Error(formatErrorMessage('Failed to commit', error), { cause: error });
      }
    }
  );

  // Pull from remote
  ipcMain.handle(
    IPC_CHANNELS.GIT_PULL,
    async (_event, workingDir: string, expectedBranch?: string) => {
      try {
        ensureService(gitService, 'GitService');
        validateString(workingDir, 'Working directory');

        return await gitService.pull(workingDir, expectedBranch);
      } catch (error) {
        logger.error('Failed to pull', { error, workingDir });
        throw new Error(formatErrorMessage('Failed to pull', error), { cause: error });
      }
    }
  );

  // Push to remote
  ipcMain.handle(
    IPC_CHANNELS.GIT_PUSH,
    async (_event, workingDir: string, expectedBranch?: string) => {
      try {
        ensureService(gitService, 'GitService');
        validateString(workingDir, 'Working directory');

        return await gitService.push(workingDir, expectedBranch);
      } catch (error) {
        logger.error('Failed to push', { error, workingDir });
        throw new Error(formatErrorMessage('Failed to push', error), { cause: error });
      }
    }
  );

  // Fetch from remote (background operation)
  ipcMain.handle(IPC_CHANNELS.GIT_FETCH, async (_event, workingDir: string) => {
    try {
      ensureService(gitService, 'GitService');
      validateString(workingDir, 'Working directory');

      await gitService.fetch(workingDir);
    } catch (error) {
      logger.error('Failed to fetch', { error, workingDir });
      throw new Error(formatErrorMessage('Failed to fetch', error), { cause: error });
    }
  });

  // List branches (local + remote-tracking)
  ipcMain.handle(IPC_CHANNELS.GIT_LIST_BRANCHES, async (_event, workingDir: string) => {
    try {
      ensureService(gitService, 'GitService');
      validateString(workingDir, 'Working directory');

      return await gitService.listBranches(workingDir);
    } catch (error) {
      logger.error('Failed to list branches', { error, workingDir });
      throw new Error(formatErrorMessage('Failed to list branches', error), { cause: error });
    }
  });

  // Checkout an existing branch
  ipcMain.handle(
    IPC_CHANNELS.GIT_CHECKOUT,
    async (_event, workingDir: string, branchName: string) => {
      try {
        ensureService(gitService, 'GitService');
        validateString(workingDir, 'Working directory');
        validateString(branchName, 'Branch name');

        return await gitService.checkoutBranch(workingDir, branchName);
      } catch (error) {
        logger.error('Failed to checkout branch', { error, workingDir, branchName });
        throw new Error(formatErrorMessage('Failed to checkout branch', error), { cause: error });
      }
    }
  );

  // Create a new branch from HEAD (and optionally check it out)
  ipcMain.handle(
    IPC_CHANNELS.GIT_CREATE_BRANCH,
    async (_event, workingDir: string, branchName: string, checkout: boolean) => {
      try {
        ensureService(gitService, 'GitService');
        validateString(workingDir, 'Working directory');
        validateString(branchName, 'Branch name');

        return await gitService.createBranch(workingDir, branchName, checkout);
      } catch (error) {
        logger.error('Failed to create branch', { error, workingDir, branchName });
        throw new Error(formatErrorMessage('Failed to create branch', error), { cause: error });
      }
    }
  );

  // Set up event-driven git status notifications
  gitService.onStatusChange((status) => {
    sendToRenderer(getMainWindow, IPC_CHANNELS.GIT_STATUS_CHANGED, status);
  });

  // Hook into FileWatcherService: when working tree files change, trigger git status refresh
  fileWatcher.onChange(() => {
    gitService.triggerRefresh();
  });

  // Start watching the current working directory if set
  configService.getWorkingDirectory().then((workingDir) => {
    if (workingDir) {
      gitService.startWatching(workingDir);
    }
  });

  logger.info('Git IPC handlers registered');
}
