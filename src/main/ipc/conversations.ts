/**
 * IPC handlers for conversation management
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { app, ipcMain } from 'electron';

import {
  AUTO_ARCHIVE_DAYS,
  AutoArchiveDays,
  ConversationListRequest,
  ConversationUpdate,
  IPC_CHANNELS,
} from '../../shared/types';
import { ConfigurationError, ValidationError, ERROR_CODES } from '../errors';
import ConversationService from '../services/ConversationService';
import { ImageStore } from '../services/ImageStore';
import { deleteSessionRecords, deleteToolResults } from '../services/claude/session-records';
import { validateString, validateObject, ensureService, formatErrorMessage } from '../utils/ipc-helpers';
import logger from '../utils/logger';

/** A count of messages to read must be a positive, finite number. */
function validateMessageCount(value: unknown, label: string, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ValidationError(`${label} must be a positive number`, field, ERROR_CODES.VALIDATION_TYPE_MISMATCH);
  }
}

/** One of the setting's choices, AUTO_ARCHIVE_DAYS. */
function validateAutoArchiveDays(value: unknown): void {
  if (!(AUTO_ARCHIVE_DAYS as readonly unknown[]).includes(value)) {
    throw new ValidationError(
      `autoArchiveDays must be one of ${AUTO_ARCHIVE_DAYS.join(', ')}`,
      'autoArchiveDays',
      ERROR_CODES.VALIDATION_TYPE_MISMATCH,
    );
  }
}

/** A message id that may be left out: null when absent, validated when given. */
function optionalMessageId(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  validateString(value as string, label);
  return value as string;
}

/** What deleting a discussion needs of its Claude Code session; see ClaudeCodeService.endConversation. */
export interface ConversationSessions {
  /** @returns whether its process exited: its records are only removed then. */
  endConversation(conversationId: string): Promise<boolean>;
}

export function setupConversationIPC(conversationService: ConversationService, sessions: ConversationSessions): void {
  // Images belong to a conversation and are deleted with it, so they are
  // registered here rather than beside the Claude handlers.
  const imageStore = new ImageStore();

  // Store bytes the user attached, returning the reference a message carries.
  ipcMain.handle(
    IPC_CHANNELS.IMAGE_SAVE,
    async (_event, conversationId: string, input: { base64: string; mediaType: string; label?: string }) => {
      try {
        validateString(conversationId, 'Conversation ID');
        validateObject(input, 'Image');
        validateString(input.base64, 'Image data');
        validateString(input.mediaType, 'Image media type');

        // Null when the store refuses it — an unsupported type or an
        // oversized image. The renderer tells the user; it is not an error.
        return await imageStore.save(conversationId, {
          base64: input.base64,
          mediaType: input.mediaType,
          origin: 'user',
          ...(input.label ? { label: input.label } : {}),
        });
      } catch (error) {
        logger.error('Failed to store an image', { error, conversationId });
        throw new ConfigurationError(
          formatErrorMessage('Failed to store the image', error),
          ERROR_CODES.CONVERSATION_SAVE_FAILED,
          error,
        );
      }
    },
  );

  // Read stored bytes back so the renderer can draw them.
  ipcMain.handle(
    IPC_CHANNELS.IMAGE_READ,
    async (_event, conversationId: string, id: string, mediaType: string) => {
      try {
        validateString(conversationId, 'Conversation ID');
        validateString(id, 'Image ID');
        validateString(mediaType, 'Image media type');
        return await imageStore.read(conversationId, id, mediaType);
      } catch (error) {
        logger.error('Failed to read an image', { error, conversationId, id });
        throw new ConfigurationError(
          formatErrorMessage('Failed to read the image', error),
          ERROR_CODES.CONVERSATION_LOAD_FAILED,
          error,
        );
      }
    },
  );

  // A page of the discussions list
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_LIST_PAGE, async (_event, request: ConversationListRequest) => {
    try {
      ensureService(conversationService, 'ConversationService');
      validateObject(request, 'List request');
      if (typeof request.archived !== 'boolean') {
        throw new ValidationError('archived must be a boolean', 'archived', ERROR_CODES.VALIDATION_TYPE_MISMATCH);
      }
      validateAutoArchiveDays(request.autoArchiveDays);
      validateMessageCount(request.limit, 'Page size', 'limit');
      if (request.after !== undefined) {
        validateObject(request.after, 'List cursor');
        validateString(request.after.id, 'List cursor id');
        if (typeof request.after.updatedAt !== 'number' || !Number.isFinite(request.after.updatedAt)) {
          throw new ValidationError('List cursor time must be a number', 'after', ERROR_CODES.VALIDATION_TYPE_MISMATCH);
        }
      }
      return await conversationService.listPage(request);
    } catch (error) {
      logger.error('Failed to list conversations', { error });
      throw new ConfigurationError(formatErrorMessage('Failed to list conversations', error), ERROR_CODES.CONVERSATION_LOAD_FAILED, error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_ARCHIVED_COUNT, async (_event, autoArchiveDays: AutoArchiveDays) => {
    try {
      ensureService(conversationService, 'ConversationService');
      validateAutoArchiveDays(autoArchiveDays);
      return await conversationService.archivedCount(autoArchiveDays);
    } catch (error) {
      logger.error('Failed to count archived conversations', { error });
      throw new ConfigurationError(formatErrorMessage('Failed to count archived conversations', error), ERROR_CODES.CONVERSATION_LOAD_FAILED, error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_SUMMARY, async (_event, id: string) => {
    try {
      ensureService(conversationService, 'ConversationService');
      validateString(id, 'Conversation ID');
      return await conversationService.summary(id);
    } catch (error) {
      logger.error('Failed to read a conversation summary', { error, id });
      throw new ConfigurationError(formatErrorMessage('Failed to read the conversation', error), ERROR_CODES.CONVERSATION_LOAD_FAILED, error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_SET_ARCHIVED, async (_event, id: string, archived: boolean) => {
    try {
      ensureService(conversationService, 'ConversationService');
      validateString(id, 'Conversation ID');
      if (typeof archived !== 'boolean') {
        throw new ValidationError('archived must be a boolean', 'archived', ERROR_CODES.VALIDATION_TYPE_MISMATCH);
      }
      return await conversationService.setArchived(id, archived);
    } catch (error) {
      logger.error('Failed to archive or restore a conversation', { error, id, archived });
      throw new ConfigurationError(formatErrorMessage('Failed to archive the conversation', error), ERROR_CODES.CONVERSATION_SAVE_FAILED, error);
    }
  });

  // Apply a change to a conversation — the only write path.
  //
  // Validated on the fields a conversation must have, minus the ones an
  // update does not carry. `upsert` must be an array even when empty: a
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
        truncateFromId: update.truncateFromId,
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
      validateMessageCount(limit, 'Window limit', 'limit');

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
        validateMessageCount(limit, 'Page limit', 'limit');

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
    async (_event, id: string, afterId: string, limit: number, untilId?: string | null) => {
      try {
        ensureService(conversationService, 'ConversationService');
        validateString(id, 'Conversation ID');
        validateString(afterId, 'Message ID');
        validateMessageCount(limit, 'Page limit', 'limit');

        const page = await conversationService.getNewer(
          id, afterId, Math.floor(limit), optionalMessageId(untilId, 'Held turn start'),
        );
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

  // The stretch of a conversation around one message — opening a search hit
  // that lies outside the window the renderer holds.
  ipcMain.handle(
    IPC_CHANNELS.CONVERSATION_GET_AROUND,
    async (
      _event, id: string, messageId: string, before: number, after: number, untilId?: string | null,
    ) => {
      try {
        ensureService(conversationService, 'ConversationService');
        validateString(id, 'Conversation ID');
        validateString(messageId, 'Message ID');
        validateMessageCount(before, 'Messages before', 'before');
        validateMessageCount(after, 'Messages after', 'after');

        // Null when the conversation or the message is not stored: an
        // answer, not a failure — the hit can simply no longer be shown.
        return await conversationService.getAround(
          id, messageId, Math.floor(before), Math.floor(after),
          optionalMessageId(untilId, 'Held turn start'),
        );
      } catch (error) {
        logger.error('Failed to get messages around a message', { error, id, messageId });
        throw new ConfigurationError(formatErrorMessage('Failed to get messages around a message', error), ERROR_CODES.CONVERSATION_LOAD_FAILED, error);
      }
    },
  );

  // The stored message holding a tool call outside the window the renderer
  // holds — the Agent call of an agent started long before, to say which
  // agent started a command.
  ipcMain.handle(
    IPC_CHANNELS.CONVERSATION_FIND_TOOL_CALL,
    async (_event, id: string, toolUseBlockId: string) => {
      try {
        ensureService(conversationService, 'ConversationService');
        validateString(id, 'Conversation ID');
        validateString(toolUseBlockId, 'Tool use ID');
        // Null when no stored message holds it: an answer, not a failure.
        return await conversationService.findToolCall(id, toolUseBlockId);
      } catch (error) {
        logger.error('Failed to find a tool call', { error, id, toolUseBlockId });
        throw new ConfigurationError(formatErrorMessage('Failed to find a tool call', error), ERROR_CODES.CONVERSATION_LOAD_FAILED, error);
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

      // Read before the details go: they are what names it.
      const sessionId = await conversationService.sessionIdOf(id);

      await conversationService.delete(id);

      // Its Claude Code process ended before its records are removed: one
      // still running writes them back as it exits.
      const ended = await sessions.endConversation(id);

      // The transcript is gone, so nothing will ever name its images again.
      // These are the largest files this app writes; left behind they are an
      // unbounded leak with no way back to them.
      await imageStore.deleteAll(id);

      const sessionDir = path.join(app.getPath('userData'), 'channel-sessions', id);
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        logger.info('Cleaned up channel session data', { conversationId: id });
      }

      // What Claude Code keeps of it (session-records). The discussion is
      // already gone: a record that cannot be removed is reported, and the
      // delete still succeeds.
      try {
        const results = await deleteToolResults(id);
        if (sessionId && !ended) {
          logger.warn('Kept the session records of a deleted discussion: its process did not exit', { id, sessionId });
        } else if (sessionId && !(await conversationService.isSessionUsed(sessionId))) {
          await deleteSessionRecords(sessionId);
        }
        logger.info('Deleted what Claude Code kept of a deleted discussion', { id, sessionId, results });
      } catch (recordsError) {
        logger.warn('Could not delete all Claude Code records of a deleted discussion', { id, sessionId, error: recordsError });
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
