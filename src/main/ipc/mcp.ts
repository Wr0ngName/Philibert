/**
 * IPC handlers for MCP server management.
 *
 * Every handler takes the project's working directory explicitly, matching the
 * git handlers, so the renderer's notion of the current project is always the
 * one being edited.
 */

import { dialog, ipcMain, BrowserWindow } from 'electron';

import { IPC_CHANNELS, type McpServerInput } from '../../shared/types';
import { ConfigurationError, ValidationError, ERROR_CODES } from '../errors';
import McpConfigService from '../services/McpConfigService';
import { validateString, validatePath, ensureService, formatErrorMessage } from '../utils/ipc-helpers';
import logger from '../utils/logger';

export function setupMcpIPC(
  mcpService: McpConfigService,
  getMainWindow: () => BrowserWindow | null
): void {
  const requireProject = (workingDirectory: unknown): string => {
    validateString(workingDirectory, 'Working directory');
    validatePath(workingDirectory);
    return workingDirectory;
  };

  ipcMain.handle(IPC_CHANNELS.MCP_LIST, async (_event, workingDirectory: string) => {
    try {
      ensureService(mcpService, 'McpConfigService');
      return mcpService.list(requireProject(workingDirectory));
    } catch (error) {
      logger.error('Failed to list MCP servers', { error });
      throw toIpcError('Failed to read the project MCP servers', error);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.MCP_SAVE,
    async (_event, workingDirectory: string, previousName: string | null, server: McpServerInput) => {
      try {
        ensureService(mcpService, 'McpConfigService');
        return mcpService.save(requireProject(workingDirectory), previousName ?? null, server);
      } catch (error) {
        logger.error('Failed to save MCP server', { error, name: server?.name });
        throw toIpcError('Failed to save the MCP server', error);
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.MCP_REMOVE, async (_event, workingDirectory: string, name: string) => {
    try {
      ensureService(mcpService, 'McpConfigService');
      validateString(name, 'Server name');
      return mcpService.remove(requireProject(workingDirectory), name);
    } catch (error) {
      logger.error('Failed to remove MCP server', { error, name });
      throw toIpcError('Failed to remove the MCP server', error);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.MCP_SET_ENABLED,
    async (_event, workingDirectory: string, name: string, enabled: boolean) => {
      try {
        ensureService(mcpService, 'McpConfigService');
        validateString(name, 'Server name');
        return mcpService.setEnabled(requireProject(workingDirectory), name, enabled === true);
      } catch (error) {
        logger.error('Failed to change MCP server approval', { error, name });
        throw toIpcError('Failed to change the MCP server', error);
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.MCP_CHECK_COMMAND, async (_event, command: string) => {
    try {
      ensureService(mcpService, 'McpConfigService');
      return mcpService.checkCommand(typeof command === 'string' ? command : '');
    } catch (error) {
      logger.error('Failed to check MCP command', { error });
      throw toIpcError('Failed to check the program', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.MCP_GET_RUNTIME_INFO, async (_event, workingDirectory: string) => {
    try {
      ensureService(mcpService, 'McpConfigService');
      return mcpService.getRuntimeInfo(requireProject(workingDirectory));
    } catch (error) {
      logger.error('Failed to read MCP runtime info', { error });
      throw toIpcError('Failed to read the MCP settings', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.MCP_PICK_EXECUTABLE, async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;

    // Windows hides extensions by default, so filter to the launchable types
    // there; on macOS and Linux server binaries usually have no extension at
    // all, which no filter can express — show everything instead.
    const filters =
      process.platform === 'win32'
        ? [
          { name: 'Programs', extensions: ['exe', 'cmd', 'bat'] },
          { name: 'All files', extensions: ['*'] },
        ]
        : [{ name: 'All files', extensions: ['*'] }];

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select the MCP server program',
      properties: ['openFile'],
      buttonLabel: 'Select',
      filters,
    });

    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(IPC_CHANNELS.MCP_PICK_FILE, async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select a file',
      properties: ['openFile'],
      buttonLabel: 'Select',
      filters: [
        { name: 'Credentials and data', extensions: ['json', 'pem', 'key', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  logger.info('MCP IPC handlers registered');
}

/**
 * Preserve the message of errors the service raised deliberately — they are
 * written for the user and shown verbatim — and wrap anything else.
 */
function toIpcError(prefix: string, error: unknown): Error {
  if (error instanceof ConfigurationError) return error;
  if (error instanceof ValidationError) return error;
  return new ConfigurationError(
    formatErrorMessage(prefix, error),
    ERROR_CODES.CONFIG_SAVE_FAILED,
    error
  );
}
