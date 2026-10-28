/**
 * IPC handlers for git operations
 */

import { BrowserWindow, ipcMain } from 'electron';

import { IPC_CHANNELS, type GitCredentialAnswer, type GitRemoteResult } from '../../shared/types';
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

  // Pull and push. Their failures come back as results, not errors: an
  // error crosses IPC as its text only, and the window needs to know when it
  // was the login that failed.
  ipcMain.handle(
    IPC_CHANNELS.GIT_PULL,
    async (_event, workingDir: string, expectedBranch?: string): Promise<GitRemoteResult> => {
      ensureService(gitService, 'GitService');
      validateString(workingDir, 'Working directory');
      const result = await gitService.pull(workingDir, expectedBranch);
      if (!result.ok) logger.error('Failed to pull', { error: result.error, auth: result.auth, workingDir });
      return result;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.GIT_PUSH,
    async (_event, workingDir: string, expectedBranch?: string): Promise<GitRemoteResult> => {
      ensureService(gitService, 'GitService');
      validateString(workingDir, 'Working directory');
      const result = await gitService.push(workingDir, expectedBranch);
      if (!result.ok) logger.error('Failed to push', { error: result.error, auth: result.auth, workingDir });
      return result;
    }
  );

  // Signing in for a push or pull: git asks the broker, which asks the
  // window. A request the window never answers — closed meanwhile — is a
  // cancel, so git does not wait out its timeout.
  const pendingCredentials = new Map<string, (answer: GitCredentialAnswer | null) => void>();
  gitService.credentials?.setAsker((request) => new Promise((resolve) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) {
      resolve(null);
      return;
    }
    const settle = (answer: GitCredentialAnswer | null) => {
      pendingCredentials.delete(request.requestId);
      window.off('closed', onClosed);
      resolve(answer);
    };
    const onClosed = () => settle(null);
    window.once('closed', onClosed);
    pendingCredentials.set(request.requestId, settle);
    logger.info('Git asks for a login', { host: request.host });
    sendToRenderer(getMainWindow, IPC_CHANNELS.GIT_CREDENTIAL_REQUEST, request);
  }));

  ipcMain.handle(
    IPC_CHANNELS.GIT_CREDENTIAL_RESPOND,
    (_event, requestId: string, answer: GitCredentialAnswer | null) => {
      validateString(requestId, 'Request id');
      const valid = answer !== null
        && typeof answer === 'object'
        && typeof answer.username === 'string'
        && typeof answer.password === 'string';
      pendingCredentials.get(requestId)?.(valid ? { username: answer.username, password: answer.password } : null);
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

  // Read git's user.name + user.email config
  ipcMain.handle(
    IPC_CHANNELS.GIT_GET_IDENTITY,
    async (_event, workingDir: string) => {
      try {
        ensureService(gitService, 'GitService');
        validateString(workingDir, 'Working directory');
        return await gitService.getIdentity(workingDir);
      } catch (error) {
        logger.error('Failed to get git identity', { error, workingDir });
        throw new Error(formatErrorMessage('Failed to get git identity', error), { cause: error });
      }
    },
  );

  // Write user.name + user.email at the chosen scope
  ipcMain.handle(
    IPC_CHANNELS.GIT_SET_IDENTITY,
    async (_event, workingDir: string, name: string, email: string, scope: 'local' | 'global') => {
      try {
        ensureService(gitService, 'GitService');
        validateString(workingDir, 'Working directory');
        validateString(name, 'Name');
        validateString(email, 'Email');
        if (scope !== 'local' && scope !== 'global') {
          throw new Error('Invalid scope: must be "local" or "global"');
        }
        await gitService.setIdentity(workingDir, name, email, scope);
      } catch (error) {
        logger.error('Failed to set git identity', { error, workingDir });
        throw new Error(formatErrorMessage('Failed to set git identity', error), { cause: error });
      }
    },
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
