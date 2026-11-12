/**
 * IPC handlers for MCP server management.
 *
 * A project's handlers take its working directory explicitly, matching the
 * git handlers, so the renderer's notion of the project is always the one
 * being edited. The tools every project has (claude.ai connectors and
 * user-wide servers) are handled with no project: they are read in a folder
 * of the app's own, and turned off everywhere in Claude Code's user settings.
 */

import { dialog, ipcMain, shell, BrowserWindow } from 'electron';

import { IPC_CHANNELS, type GlobalTools, type GlobalToolStatus, type McpServerInput, type ProjectTools } from '../../shared/types';
import type ClaudeCodeService from '../services/ClaudeCodeService';
import McpConfigService from '../services/McpConfigService';
import { readGloballyOff, setGloballyOff } from '../services/claude/mcp-global-off';
import { validateString, validatePath, ensureService, toSettingsIpcError } from '../utils/ipc-helpers';
import logger from '../utils/logger';

export function setupMcpIPC(
  mcpService: McpConfigService,
  claudeService: ClaudeCodeService,
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
      throw toSettingsIpcError('Failed to read the project MCP servers', error);
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
        throw toSettingsIpcError('Failed to save the MCP server', error);
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
      throw toSettingsIpcError('Failed to remove the MCP server', error);
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
        throw toSettingsIpcError('Failed to change the MCP server', error);
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.MCP_CHECK_COMMAND, async (_event, command: string) => {
    try {
      ensureService(mcpService, 'McpConfigService');
      return mcpService.checkCommand(typeof command === 'string' ? command : '');
    } catch (error) {
      logger.error('Failed to check MCP command', { error });
      throw toSettingsIpcError('Failed to check the program', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.MCP_GET_RUNTIME_INFO, async () => {
    try {
      ensureService(mcpService, 'McpConfigService');
      return mcpService.getRuntimeInfo();
    } catch (error) {
      logger.error('Failed to read MCP runtime info', { error });
      throw toSettingsIpcError('Failed to read the MCP settings', error);
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

  /** The tools every project has, and how each stands. */
  const globalTools = async (): Promise<GlobalTools> => {
    const [statuses, userServers, off] = await Promise.all([
      claudeService.getGlobalToolStatuses(),
      mcpService.listUser(),
      readGloballyOff(),
    ]);
    return { statuses, userServers, offEverywhere: [...off] };
  };

  /** The tools every project has, as this project has them. */
  const projectTools = async (workingDirectory: string, statuses?: GlobalToolStatus[] | null): Promise<ProjectTools> => {
    const [projectStatuses, userServers, off] = await Promise.all([
      statuses !== undefined ? statuses : claudeService.getProjectToolStatuses(workingDirectory),
      mcpService.listUser(),
      readGloballyOff(),
    ]);
    return { statuses: projectStatuses, userServers: userServers.map((s) => s.name), offEverywhere: [...off] };
  };

  ipcMain.handle(IPC_CHANNELS.MCP_GLOBAL_TOOLS, async () => {
    try {
      ensureService(claudeService, 'ClaudeCodeService');
      return await globalTools();
    } catch (error) {
      logger.error('Failed to read the tools every project has', { error });
      throw toSettingsIpcError('Failed to check your tools', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.MCP_SET_OFF_EVERYWHERE, async (_event, name: string, off: boolean) => {
    try {
      ensureService(claudeService, 'ClaudeCodeService');
      validateString(name, 'Tool name');
      await setGloballyOff(name, off === true);
      return await globalTools();
    } catch (error) {
      logger.error('Failed to turn a tool off everywhere, or back on', { error, name });
      throw toSettingsIpcError('Failed to change the tool', error);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.MCP_USER_SAVE,
    async (_event, previousName: string | null, server: McpServerInput) => {
      try {
        ensureService(mcpService, 'McpConfigService');
        return await mcpService.saveUser(previousName ?? null, server);
      } catch (error) {
        logger.error('Failed to save a user-wide MCP server', { error, name: server?.name });
        throw toSettingsIpcError('Failed to save the MCP server', error);
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.MCP_USER_REMOVE, async (_event, name: string) => {
    try {
      ensureService(mcpService, 'McpConfigService');
      validateString(name, 'Server name');
      return await mcpService.removeUser(name);
    } catch (error) {
      logger.error('Failed to remove a user-wide MCP server', { error, name });
      throw toSettingsIpcError('Failed to remove the MCP server', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.MCP_PROJECT_TOOLS, async (_event, workingDirectory: string) => {
    try {
      ensureService(claudeService, 'ClaudeCodeService');
      return await projectTools(requireProject(workingDirectory));
    } catch (error) {
      logger.error('Failed to read the tools of a project', { error });
      throw toSettingsIpcError("Failed to check the project's tools", error);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.MCP_SET_ENABLED_IN_PROJECT,
    async (_event, workingDirectory: string, name: string, enabled: boolean) => {
      try {
        ensureService(claudeService, 'ClaudeCodeService');
        validateString(name, 'Tool name');
        const dir = requireProject(workingDirectory);
        const statuses = await claudeService.setToolEnabledInProject(dir, name, enabled === true);
        return await projectTools(dir, statuses);
      } catch (error) {
        logger.error('Failed to turn a tool on or off in a project', { error, name });
        throw toSettingsIpcError('Failed to change the tool', error);
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.MCP_CONNECTOR_AUTHORIZE, async (_event, name: string) => {
    try {
      ensureService(claudeService, 'ClaudeCodeService');
      validateString(name, 'Connector name');
      const page = await claudeService.getConnectorAuthPage(name);
      await shell.openExternal(page);
    } catch (error) {
      logger.error('Failed to authorise a claude.ai connector', { error, name });
      throw toSettingsIpcError(`Failed to open the page that authorises ${String(name)}`, error);
    }
  });

  logger.info('MCP IPC handlers registered');
}
