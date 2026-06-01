/**
 * IPC handlers for Claude Code SDK integration.
 *
 * This module handles all communication between the renderer process
 * and the Claude Code Agent SDK, including:
 * - Sending user messages to Claude
 * - Tool use approval/rejection
 * - Aborting ongoing requests
 * - Retrieving available slash commands
 *
 * @module ipc/claude
 */

import { ipcMain } from 'electron';

import { IPC_CHANNELS, ActionResponse, PermissionScope } from '../../shared/types';
import { IpcError, ValidationError, AppError, ERROR_CODES } from '../errors';
import ClaudeCodeService from '../services/ClaudeCodeService';
import { validateString, validateObject, validateBoolean, formatErrorMessage, ensureService } from '../utils/ipc-helpers';
import logger from '../utils/logger';

/**
 * Register IPC handlers for Claude Code operations.
 *
 * @param claudeService - The ClaudeCodeService instance to use for SDK operations
 */
export function setupClaudeIPC(claudeService: ClaudeCodeService): void {
  // Send message to Claude
  ipcMain.handle(IPC_CHANNELS.CLAUDE_SEND, async (_event, conversationId: string, message: string, workingDir: string, resumeSessionId?: string) => {
    try {
      logger.debug('IPC: claude:send', {
        conversationId,
        messageLength: message?.length || 0,
        hasResumeSession: !!resumeSessionId,
      });

      // Validate service
      ensureService(claudeService, 'ClaudeCodeService');

      // Validate inputs
      validateString(conversationId, 'Conversation ID');
      validateString(message, 'Message');
      validateString(workingDir, 'Working directory');

      await claudeService.sendMessage(conversationId, message, workingDir, resumeSessionId);
    } catch (error) {
      logger.error('Failed to send message to Claude', { error, conversationId, messageLength: message?.length });
      throw new IpcError(formatErrorMessage('Failed to send message', error), IPC_CHANNELS.CLAUDE_SEND, ERROR_CODES.CLAUDE_SEND_FAILED, error);
    }
  });

  // Approve a pending action with optional parameters
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_APPROVE,
    async (
      _event,
      conversationId: string,
      actionId: string,
      updatedInput?: Record<string, unknown>,
      alwaysAllow?: boolean,
      chosenScope?: PermissionScope
    ) => {
      try {
        logger.debug('IPC: claude:approve', { conversationId, actionId, alwaysAllow, chosenScope });

        // Validate service
        ensureService(claudeService, 'ClaudeCodeService');

        // Validate inputs
        validateString(conversationId, 'Conversation ID');
        validateString(actionId, 'Action ID');

        if (updatedInput !== undefined) {
          validateObject(updatedInput, 'Updated input');
        }

        if (alwaysAllow !== undefined) {
          validateBoolean(alwaysAllow, 'alwaysAllow');
        }

        if (chosenScope !== undefined) {
          validateString(chosenScope, 'chosenScope');
        }

        await claudeService.approveAction(conversationId, actionId, updatedInput, alwaysAllow, chosenScope);
      } catch (error) {
        logger.error('Failed to approve action', { error, conversationId, actionId });
        throw new IpcError(formatErrorMessage('Failed to approve action', error), IPC_CHANNELS.CLAUDE_APPROVE, ERROR_CODES.IPC_HANDLER_FAILED, error);
      }
    }
  );

  // Reject a pending action with optional denial message
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_REJECT,
    async (_event, conversationId: string, actionId: string, message?: string) => {
      try {
        logger.debug('IPC: claude:reject', { conversationId, actionId, message });

        // Validate service
        ensureService(claudeService, 'ClaudeCodeService');

        // Validate inputs
        validateString(conversationId, 'Conversation ID');
        validateString(actionId, 'Action ID');

        if (message !== undefined && typeof message !== 'string') {
          throw new ValidationError('Invalid message type: must be a string', 'message', ERROR_CODES.VALIDATION_TYPE_MISMATCH);
        }

        await claudeService.rejectAction(conversationId, actionId, message);
      } catch (error) {
        logger.error('Failed to reject action', { error, conversationId, actionId });
        throw new IpcError(formatErrorMessage('Failed to reject action', error), IPC_CHANNELS.CLAUDE_REJECT, ERROR_CODES.IPC_HANDLER_FAILED, error);
      }
    }
  );

  // Handle full action response (alternative to approve/reject)
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_ACTION_RESPONSE,
    async (_event, response: ActionResponse) => {
      try {
        logger.debug('IPC: claude:action-response', {
          conversationId: response?.conversationId,
          actionId: response?.actionId,
          approved: response?.approved,
        });

        // Validate service
        ensureService(claudeService, 'ClaudeCodeService');

        // Validate input
        validateObject(response, 'Response');

        if (typeof response.conversationId !== 'string' || !response.conversationId.trim()) {
          throw new ValidationError('Invalid conversation ID in response', 'conversationId', ERROR_CODES.VALIDATION_REQUIRED);
        }

        if (typeof response.actionId !== 'string' || !response.actionId.trim()) {
          throw new ValidationError('Invalid action ID in response', 'actionId', ERROR_CODES.VALIDATION_REQUIRED);
        }

        if (typeof response.approved !== 'boolean') {
          throw new ValidationError('Invalid approved status: must be a boolean', 'approved', ERROR_CODES.VALIDATION_TYPE_MISMATCH);
        }

        claudeService.handleActionResponse(response.conversationId, response);
      } catch (error) {
        logger.error('Failed to handle action response', { error, response });
        throw new IpcError(formatErrorMessage('Failed to handle action response', error), IPC_CHANNELS.CLAUDE_ACTION_RESPONSE, ERROR_CODES.IPC_HANDLER_FAILED, error);
      }
    }
  );

  // Abort request for a specific conversation
  ipcMain.handle(IPC_CHANNELS.CLAUDE_ABORT, async (_event, conversationId: string) => {
    try {
      logger.debug('IPC: claude:abort', { conversationId });

      // Validate service
      ensureService(claudeService, 'ClaudeCodeService');

      // Validate input
      validateString(conversationId, 'Conversation ID');

      await claudeService.abort(conversationId);
    } catch (error) {
      logger.error('Failed to abort Claude request', { error, conversationId });
      throw new AppError(formatErrorMessage('Failed to abort request', error), ERROR_CODES.CLAUDE_ABORT_FAILED, error);
    }
  });

  // Get available slash commands
  ipcMain.handle(IPC_CHANNELS.CLAUDE_GET_COMMANDS, async () => {
    try {
      logger.debug('IPC: claude:get-commands');

      // Validate service
      ensureService(claudeService, 'ClaudeCodeService');

      return claudeService.getSlashCommands();
    } catch (error) {
      logger.error('Failed to get slash commands', { error });
      throw new IpcError(formatErrorMessage('Failed to get slash commands', error), IPC_CHANNELS.CLAUDE_GET_COMMANDS, ERROR_CODES.IPC_HANDLER_FAILED, error);
    }
  });

  // Get available models from SDK
  ipcMain.handle(IPC_CHANNELS.CLAUDE_GET_MODELS, async () => {
    try {
      logger.debug('IPC: claude:get-models');

      // Validate service
      ensureService(claudeService, 'ClaudeCodeService');

      return await claudeService.getModels();
    } catch (error) {
      logger.error('Failed to get models', { error });
      throw new IpcError(formatErrorMessage('Failed to get models', error), IPC_CHANNELS.CLAUDE_GET_MODELS, ERROR_CODES.IPC_HANDLER_FAILED, error);
    }
  });

  // Get active query status
  ipcMain.handle(IPC_CHANNELS.CLAUDE_GET_ACTIVE_QUERIES, async () => {
    try {
      logger.debug('IPC: claude:get-active-queries');

      // Validate service
      ensureService(claudeService, 'ClaudeCodeService');

      return {
        count: claudeService.getActiveQueryCount(),
        maxCount: claudeService.getMaxConcurrentQueries(),
        processingCount: claudeService.getProcessingQueryCount(),
        activeConversationIds: claudeService.getActiveConversationIds(),
      };
    } catch (error) {
      logger.error('Failed to get active queries', { error });
      throw new IpcError(formatErrorMessage('Failed to get active queries', error), IPC_CHANNELS.CLAUDE_GET_ACTIVE_QUERIES, ERROR_CODES.IPC_HANDLER_FAILED, error);
    }
  });

  // Get session permissions for a conversation
  ipcMain.handle(IPC_CHANNELS.CLAUDE_GET_SESSION_PERMISSIONS, async (_event, conversationId: string) => {
    try {
      logger.debug('IPC: claude:get-session-permissions', { conversationId });
      ensureService(claudeService, 'ClaudeCodeService');
      validateString(conversationId, 'Conversation ID');
      return claudeService.getSessionPermissions(conversationId);
    } catch (error) {
      logger.error('Failed to get session permissions', { error, conversationId });
      throw new IpcError(formatErrorMessage('Failed to get session permissions', error), IPC_CHANNELS.CLAUDE_GET_SESSION_PERMISSIONS, ERROR_CODES.CLAUDE_PERMISSION_FAILED, error);
    }
  });

  // Revoke a session permission
  ipcMain.handle(IPC_CHANNELS.CLAUDE_REVOKE_SESSION_PERMISSION, async (_event, conversationId: string, permissionId: string) => {
    try {
      logger.debug('IPC: claude:revoke-session-permission', { conversationId, permissionId });
      ensureService(claudeService, 'ClaudeCodeService');
      validateString(conversationId, 'Conversation ID');
      validateString(permissionId, 'Permission ID');
      return claudeService.revokeSessionPermission(conversationId, permissionId);
    } catch (error) {
      logger.error('Failed to revoke session permission', { error, conversationId, permissionId });
      throw new IpcError(formatErrorMessage('Failed to revoke session permission', error), IPC_CHANNELS.CLAUDE_REVOKE_SESSION_PERMISSION, ERROR_CODES.CLAUDE_PERMISSION_FAILED, error);
    }
  });

  // Clear all session permissions for a conversation
  ipcMain.handle(IPC_CHANNELS.CLAUDE_CLEAR_SESSION_PERMISSIONS, async (_event, conversationId: string) => {
    try {
      logger.debug('IPC: claude:clear-session-permissions', { conversationId });
      ensureService(claudeService, 'ClaudeCodeService');
      validateString(conversationId, 'Conversation ID');
      claudeService.clearSessionPermissions(conversationId);
    } catch (error) {
      logger.error('Failed to clear session permissions', { error, conversationId });
      throw new IpcError(formatErrorMessage('Failed to clear session permissions', error), IPC_CHANNELS.CLAUDE_CLEAR_SESSION_PERMISSIONS, ERROR_CODES.CLAUDE_PERMISSION_FAILED, error);
    }
  });

  logger.info('Claude IPC handlers registered');
}
