/**
 * IPC handlers for conversation management
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { app, ipcMain } from 'electron';

import { Conversation, ConversationUpdate, IPC_CHANNELS } from '../../shared/types';
import { ConfigurationError, ValidationError, ERROR_CODES } from '../errors';
import ConversationService from '../services/ConversationService';
import { validateString, validateObject, ensureService, formatErrorMessage } from '../utils/ipc-helpers';
import logger from '../utils/logger';

export function setupConversationIPC(conversationService: ConversationService): void {
  // List all conversations
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_LIST, async () => {
    try {
      logger.info('IPC: conversation:list called');

      // Validate service
      ensureService(conversationService, 'ConversationService');

      const conversations = await conversationService.list();

      if (!Array.isArray(conversations)) {
        throw new ConfigurationError('Invalid conversation list returned', ERROR_CODES.CONVERSATION_LOAD_FAILED);
      }

      return conversations;
    } catch (error) {
      logger.error('Failed to list conversations', { error });
      throw new ConfigurationError(formatErrorMessage('Failed to list conversations', error), ERROR_CODES.CONVERSATION_LOAD_FAILED, error);
    }
  });

  // Get a single conversation
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_GET, async (_event, id: string) => {
    try {
      logger.debug('IPC: conversation:get', { id });

      // Validate service
      ensureService(conversationService, 'ConversationService');

      // Validate input
      validateString(id, 'Conversation ID');

      const conversation = await conversationService.get(id);

      if (!conversation) {
        throw new ConfigurationError(`Conversation not found: ${id}`, ERROR_CODES.CONVERSATION_NOT_FOUND);
      }

      return conversation;
    } catch (error) {
      logger.error('Failed to get conversation', { error, id });
      throw new ConfigurationError(formatErrorMessage('Failed to get conversation', error), ERROR_CODES.CONVERSATION_LOAD_FAILED, error);
    }
  });

  // Save a conversation
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_SAVE, async (_event, conversation: Conversation) => {
    try {
      // Validate service first
      ensureService(conversationService, 'ConversationService');

      // Validate input BEFORE logging to prevent errors during logging
      validateObject(conversation, 'Conversation');

      if (typeof conversation.id !== 'string' || !conversation.id.trim()) {
        throw new ValidationError('Conversation ID is required and must be a non-empty string', 'id', ERROR_CODES.VALIDATION_REQUIRED);
      }

      if (typeof conversation.title !== 'string') {
        throw new ValidationError('Conversation title must be a string', 'title', ERROR_CODES.VALIDATION_TYPE_MISMATCH);
      }

      if (typeof conversation.workingDirectory !== 'string') {
        throw new ValidationError('Conversation workingDirectory must be a string', 'workingDirectory', ERROR_CODES.VALIDATION_TYPE_MISMATCH);
      }

      if (!Array.isArray(conversation.messages)) {
        throw new ValidationError('Conversation messages must be an array', 'messages', ERROR_CODES.VALIDATION_TYPE_MISMATCH);
      }

      if (typeof conversation.createdAt !== 'number' || conversation.createdAt <= 0) {
        throw new ValidationError('Conversation createdAt must be a positive timestamp', 'createdAt', ERROR_CODES.VALIDATION_TYPE_MISMATCH);
      }

      if (typeof conversation.updatedAt !== 'number' || conversation.updatedAt <= 0) {
        throw new ValidationError('Conversation updatedAt must be a positive timestamp', 'updatedAt', ERROR_CODES.VALIDATION_TYPE_MISMATCH);
      }

      // Now safe to log after validation
      logger.info('IPC: conversation:save called', {
        id: conversation.id,
        messageCount: conversation.messages.length,
        title: conversation.title.slice(0, 30),
        workingDirectory: conversation.workingDirectory,
      });

      await conversationService.save(conversation);

      logger.debug('IPC: conversation:save completed', { id: conversation.id });
    } catch (error) {
      const errorMessage = error instanceof ValidationError
        ? `Validation error: ${error.message} (field: ${error.field})`
        : error instanceof Error
          ? error.message
          : String(error);

      logger.error('Failed to save conversation', {
        error: errorMessage,
        id: conversation?.id,
      });

      throw new ConfigurationError(
        `Failed to save conversation: ${errorMessage}`,
        ERROR_CODES.CONVERSATION_SAVE_FAILED,
        error
      );
    }
  });

  // Apply a change to a conversation — the renderer's only write path.
  //
  // Validated on the same fields as the full save it replaced, minus the ones
  // an update does not carry. `upsert` must be an array even when empty: a
  // write that only changes metadata (a session id, the task list) is
  // legitimate.
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_UPDATE, async (_event, update: ConversationUpdate) => {
    try {
      ensureService(conversationService, 'ConversationService');
      validateObject(update, 'Conversation update');

      if (typeof update.id !== 'string' || !update.id.trim()) {
        throw new ValidationError('Conversation ID is required and must be a non-empty string', 'id', ERROR_CODES.VALIDATION_REQUIRED);
      }
      if (!Array.isArray(update.upsert)) {
        throw new ValidationError('Conversation update upsert must be an array', 'upsert', ERROR_CODES.VALIDATION_TYPE_MISMATCH);
      }
      if (typeof update.workingDirectory !== 'string') {
        throw new ValidationError('Conversation workingDirectory must be a string', 'workingDirectory', ERROR_CODES.VALIDATION_TYPE_MISMATCH);
      }
      if (typeof update.updatedAt !== 'number' || update.updatedAt <= 0) {
        throw new ValidationError('Conversation updatedAt must be a positive timestamp', 'updatedAt', ERROR_CODES.VALIDATION_TYPE_MISMATCH);
      }

      logger.info('IPC: conversation:update called', {
        id: update.id,
        upsertCount: update.upsert.length,
        truncateAfterId: update.truncateAfterId,
        truncateAll: update.truncateAll === true,
      });

      await conversationService.update(update);
    } catch (error) {
      const errorMessage = error instanceof ValidationError
        ? `Validation error: ${error.message} (field: ${error.field})`
        : error instanceof Error ? error.message : String(error);
      logger.error('Failed to update conversation', { error: errorMessage, id: update?.id });
      throw new ConfigurationError(
        `Failed to update conversation: ${errorMessage}`,
        ERROR_CODES.CONVERSATION_SAVE_FAILED,
        error,
      );
    }
  });

  // A conversation's tail, plus how many messages are older than it.
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_GET_WINDOW, async (_event, id: string, limit: number) => {
    try {
      ensureService(conversationService, 'ConversationService');
      validateString(id, 'Conversation ID');
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
        throw new ValidationError('Window limit must be a positive number', 'limit', ERROR_CODES.VALIDATION_TYPE_MISMATCH);
      }

      // Null means there is no such conversation, which is an answer rather
      // than a failure — the renderer says so, and keeps "failed to load" for
      // a read that actually broke. Conflating the two told the user their
      // disk had failed when they had simply opened something deleted, and
      // vice versa.
      const window = await conversationService.getWindow(id, Math.floor(limit));
      if (!window) {
        logger.debug('IPC: conversation:get-window — no such conversation', { id });
        return null;
      }
      logger.debug('IPC: conversation:get-window', {
        id, returned: window.conversation.messages.length, olderCount: window.olderCount,
      });
      return window;
    } catch (error) {
      logger.error('Failed to get conversation window', { error, id });
      throw new ConfigurationError(formatErrorMessage('Failed to get conversation window', error), ERROR_CODES.CONVERSATION_LOAD_FAILED, error);
    }
  });

  // A page of messages older than the one the renderer holds at its top.
  ipcMain.handle(
    IPC_CHANNELS.CONVERSATION_GET_OLDER,
    async (_event, id: string, beforeId: string, limit: number) => {
      try {
        ensureService(conversationService, 'ConversationService');
        validateString(id, 'Conversation ID');
        validateString(beforeId, 'Message ID');
        if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
          throw new ValidationError('Page limit must be a positive number', 'limit', ERROR_CODES.VALIDATION_TYPE_MISMATCH);
        }

        const page = await conversationService.getOlder(id, beforeId, Math.floor(limit));
        if (!page) {
          throw new ConfigurationError(`Conversation not found: ${id}`, ERROR_CODES.CONVERSATION_NOT_FOUND);
        }
        logger.debug('IPC: conversation:get-older', {
          id, beforeId, returned: page.messages.length, olderCount: page.olderCount,
        });
        return page;
      } catch (error) {
        logger.error('Failed to get older messages', { error, id, beforeId });
        throw new ConfigurationError(formatErrorMessage('Failed to get older messages', error), ERROR_CODES.CONVERSATION_LOAD_FAILED, error);
      }
    },
  );

  // A page of messages newer than the one the renderer holds at its bottom.
  ipcMain.handle(
    IPC_CHANNELS.CONVERSATION_GET_NEWER,
    async (_event, id: string, afterId: string, limit: number) => {
      try {
        ensureService(conversationService, 'ConversationService');
        validateString(id, 'Conversation ID');
        validateString(afterId, 'Message ID');
        if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
          throw new ValidationError('Page limit must be a positive number', 'limit', ERROR_CODES.VALIDATION_TYPE_MISMATCH);
        }

        const page = await conversationService.getNewer(id, afterId, Math.floor(limit));
        if (!page) {
          logger.debug('IPC: conversation:get-newer — no such conversation', { id });
          return null;
        }
        return page;
      } catch (error) {
        logger.error('Failed to get newer messages', { error, id, afterId });
        throw new ConfigurationError(formatErrorMessage('Failed to get newer messages', error), ERROR_CODES.CONVERSATION_LOAD_FAILED, error);
      }
    },
  );

  // Rename a conversation
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_RENAME, async (_event, id: string, newTitle: string) => {
    try {
      logger.debug('IPC: conversation:rename', { id, newTitle: newTitle?.slice(0, 30) });

      // Validate service
      ensureService(conversationService, 'ConversationService');

      // Validate inputs
      validateString(id, 'Conversation ID');
      validateString(newTitle, 'New title');

      await conversationService.rename(id, newTitle);
    } catch (error) {
      logger.error('Failed to rename conversation', { error, id });
      throw new ConfigurationError(formatErrorMessage('Failed to rename conversation', error), ERROR_CODES.CONVERSATION_SAVE_FAILED, error);
    }
  });

  // Delete a conversation
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_DELETE, async (_event, id: string) => {
    try {
      logger.debug('IPC: conversation:delete', { id });

      // Validate service
      ensureService(conversationService, 'ConversationService');

      // Validate input
      validateString(id, 'Conversation ID');

      await conversationService.delete(id);

      const sessionDir = path.join(app.getPath('userData'), 'channel-sessions', id);
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        logger.info('Cleaned up channel session data', { conversationId: id });
      }
    } catch (error) {
      logger.error('Failed to delete conversation', { error, id });
      throw new ConfigurationError(formatErrorMessage('Failed to delete conversation', error), ERROR_CODES.CONVERSATION_SAVE_FAILED, error);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.CONVERSATION_SEARCH,
    async (
      _event,
      query: string,
      scope: 'current' | 'all',
      currentConversationId: string | null,
    ) => {
      try {
        ensureService(conversationService, 'ConversationService');
        validateString(query, 'Query');
        if (scope !== 'current' && scope !== 'all') {
          throw new Error('Invalid scope: must be "current" or "all"');
        }
        return await conversationService.search(query, scope, currentConversationId ?? null);
      } catch (error) {
        logger.error('Failed to search conversations', { error });
        throw new ConfigurationError(
          formatErrorMessage('Failed to search conversations', error),
          ERROR_CODES.CONVERSATION_SAVE_FAILED,
          error,
        );
      }
    },
  );

  logger.info('Conversation IPC handlers registered');
}
