/**
 * IPC (Inter-Process Communication) setup module.
 *
 * This module is the central registration point for all IPC handlers
 * that enable communication between the main process and renderer process.
 *
 * @module ipc
 *
 * IPC channels are organized by domain:
 * - auth: Authentication (OAuth, API keys)
 * - claude: Claude Code SDK integration
 * - config: Application configuration
 * - conversations: Chat history persistence
 * - files: File system operations and watching
 * - mcp: Project MCP server definitions and approvals
 * - update: Auto-update functionality
 * - window: Window management (minimize, maximize, close)
 */

import { BrowserWindow, ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../shared/types';
import { ValidationError, ERROR_CODES } from '../errors';
import AuthService from '../services/AuthService';
import ClaudeCodeService from '../services/ClaudeCodeService';
import ConfigService from '../services/ConfigService';
import ConversationService from '../services/ConversationService';
import FileWatcherService from '../services/FileWatcherService';
import GitService from '../services/GitService';
import McpConfigService from '../services/McpConfigService';
import UpdateService from '../services/UpdateService';
import logger from '../utils/logger';

import { setupAuthHandlers } from './auth';
import { setupClaudeIPC } from './claude';
import { setupConfigIPC } from './config';
import { setupConversationIPC } from './conversations';
import { setupFilesIPC } from './files';
import { setupGitIPC } from './git';
import { setupMcpIPC } from './mcp';
import { setupUpdateIPC } from './update';
import { setupWindowIPC } from './window';

/**
 * All IPC channels registered by this module.
 * Used for targeted cleanup instead of removeAllListeners().
 */
const REGISTERED_CHANNELS = {
  // Handlers (ipcMain.handle) - use removeHandler
  handlers: [
    IPC_CHANNELS.AUTH_GET_STATUS,
    IPC_CHANNELS.AUTH_START_OAUTH,
    IPC_CHANNELS.AUTH_COMPLETE_OAUTH,
    IPC_CHANNELS.AUTH_LOGOUT,
    IPC_CHANNELS.CLAUDE_SEND,
    IPC_CHANNELS.CLAUDE_APPROVE,
    IPC_CHANNELS.CLAUDE_REJECT,
    IPC_CHANNELS.CLAUDE_ACTION_RESPONSE,
    IPC_CHANNELS.CLAUDE_ABORT,
    IPC_CHANNELS.CLAUDE_GET_COMMANDS,
    IPC_CHANNELS.CLAUDE_GET_SESSION_PERMISSIONS,
    IPC_CHANNELS.CLAUDE_REVOKE_SESSION_PERMISSION,
    IPC_CHANNELS.CLAUDE_CLEAR_SESSION_PERMISSIONS,
    IPC_CHANNELS.CONFIG_GET,
    IPC_CHANNELS.CONFIG_SET,
    IPC_CHANNELS.MCP_LIST,
    IPC_CHANNELS.MCP_SAVE,
    IPC_CHANNELS.MCP_REMOVE,
    IPC_CHANNELS.MCP_SET_ENABLED,
    IPC_CHANNELS.MCP_CHECK_COMMAND,
    IPC_CHANNELS.MCP_GET_RUNTIME_INFO,
    IPC_CHANNELS.MCP_PICK_EXECUTABLE,
    IPC_CHANNELS.MCP_PICK_FILE,
    IPC_CHANNELS.CONVERSATION_LIST,
    IPC_CHANNELS.CONVERSATION_GET,
    IPC_CHANNELS.CONVERSATION_SAVE,
    IPC_CHANNELS.CONVERSATION_DELETE,
    IPC_CHANNELS.FILES_SELECT_DIR,
    IPC_CHANNELS.FILES_GET_TREE,
    IPC_CHANNELS.FILES_READ,
    IPC_CHANNELS.FILES_OPEN,
    IPC_CHANNELS.GIT_STATUS,
    IPC_CHANNELS.GIT_COMMIT,
    IPC_CHANNELS.GIT_PULL,
    IPC_CHANNELS.GIT_PUSH,
    IPC_CHANNELS.GIT_FETCH,
    IPC_CHANNELS.UPDATE_CHECK,
    IPC_CHANNELS.UPDATE_DOWNLOAD,
    IPC_CHANNELS.UPDATE_INSTALL,
  ] as const,
  // Listeners (ipcMain.on) - use removeAllListeners on specific channel
  listeners: [
    IPC_CHANNELS.WINDOW_MINIMIZE,
    IPC_CHANNELS.WINDOW_MAXIMIZE,
    IPC_CHANNELS.WINDOW_CLOSE,
  ] as const,
};

/**
 * Service instances required for IPC handlers.
 * All services must be initialized before calling setupIPC.
 */
interface Services {
  /** OAuth and API key authentication */
  authService: AuthService;
  /** Application configuration persistence */
  configService: ConfigService;
  /** Claude Code SDK integration */
  claudeService: ClaudeCodeService;
  /** File system watching for the working directory */
  fileWatcher: FileWatcherService;
  /** Git repository operations */
  gitService: GitService;
  /** Project MCP server definitions and approvals */
  mcpService: McpConfigService;
  /** Conversation history storage */
  conversationService: ConversationService;
  /** Auto-update functionality */
  updateService: UpdateService;
}

/**
 * Register all IPC handlers for main-renderer communication.
 *
 * This function must be called once during app initialization, after all
 * services are created but before the renderer process starts sending messages.
 *
 * @param services - All service instances required by the IPC handlers
 * @param getMainWindow - Function to get the current main BrowserWindow instance
 * @returns Cleanup function that removes all IPC handlers (call on app quit)
 * @throws {ValidationError} If any required service is missing
 *
 * @example
 * ```typescript
 * const cleanup = setupIPC(services, getMainWindow);
 * app.on('before-quit', cleanup);
 * ```
 */
export function setupIPC(
  services: Services,
  getMainWindow: () => BrowserWindow | null
): () => void {
  try {
    // Validate services
    if (!services) {
      throw new ValidationError('Services object is required', 'services', ERROR_CODES.VALIDATION_REQUIRED);
    }

    const {
      authService,
      configService,
      claudeService,
      fileWatcher,
      gitService,
      mcpService,
      conversationService,
      updateService,
    } = services;

    if (!authService) {
      throw new ValidationError('AuthService is required', 'authService', ERROR_CODES.VALIDATION_REQUIRED);
    }
    if (!configService) {
      throw new ValidationError('ConfigService is required', 'configService', ERROR_CODES.VALIDATION_REQUIRED);
    }
    if (!claudeService) {
      throw new ValidationError('ClaudeCodeService is required', 'claudeService', ERROR_CODES.VALIDATION_REQUIRED);
    }
    if (!fileWatcher) {
      throw new ValidationError('FileWatcherService is required', 'fileWatcher', ERROR_CODES.VALIDATION_REQUIRED);
    }
    if (!gitService) {
      throw new ValidationError('GitService is required', 'gitService', ERROR_CODES.VALIDATION_REQUIRED);
    }
    if (!mcpService) {
      throw new ValidationError('McpConfigService is required', 'mcpService', ERROR_CODES.VALIDATION_REQUIRED);
    }
    if (!conversationService) {
      throw new ValidationError('ConversationService is required', 'conversationService', ERROR_CODES.VALIDATION_REQUIRED);
    }
    if (!updateService) {
      throw new ValidationError('UpdateService is required', 'updateService', ERROR_CODES.VALIDATION_REQUIRED);
    }
    if (typeof getMainWindow !== 'function') {
      throw new ValidationError('getMainWindow must be a function', 'getMainWindow', ERROR_CODES.VALIDATION_TYPE_MISMATCH);
    }

    setupAuthHandlers(authService, configService, getMainWindow);
    setupClaudeIPC(claudeService);
    setupFilesIPC(fileWatcher, configService, getMainWindow);
    setupGitIPC(gitService, configService, fileWatcher, getMainWindow);
    setupConfigIPC(configService, getMainWindow);
    setupMcpIPC(mcpService, getMainWindow);
    setupConversationIPC(conversationService);
    setupUpdateIPC(updateService);
    setupWindowIPC();

    logger.info('All IPC handlers registered');

    // Return cleanup function that only removes handlers we registered
    return () => {
      try {
        logger.info('Cleaning up IPC handlers');

        // Remove handlers (registered with ipcMain.handle)
        for (const channel of REGISTERED_CHANNELS.handlers) {
          try {
            ipcMain.removeHandler(channel);
          } catch (err) {
            logger.debug(`Handler ${channel} already removed or not registered`, err);
          }
        }

        // Remove listeners (registered with ipcMain.on)
        for (const channel of REGISTERED_CHANNELS.listeners) {
          try {
            ipcMain.removeAllListeners(channel);
          } catch (err) {
            logger.debug(`Listener ${channel} already removed or not registered`, err);
          }
        }

        logger.info('IPC handlers cleaned up', {
          handlersRemoved: REGISTERED_CHANNELS.handlers.length,
          listenersRemoved: REGISTERED_CHANNELS.listeners.length,
        });
      } catch (error) {
        logger.error('Failed to cleanup IPC handlers', { error });
      }
    };
  } catch (error) {
    logger.error('Failed to setup IPC handlers', { error });
    throw new ValidationError(`Failed to setup IPC handlers: ${error instanceof Error ? error.message : String(error)}`, undefined, ERROR_CODES.IPC_HANDLER_FAILED, error);
  }
}
