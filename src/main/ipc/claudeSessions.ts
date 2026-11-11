/**
 * IPC handlers for Claude Code's own session files: whether a session is
 * still on disk, and how long Claude Code keeps them (`cleanupPeriodDays`).
 */

import { ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../shared/types';
import { ValidationError, ERROR_CODES } from '../errors';
import { readSessionRetention, writeSessionRetention } from '../services/claude/session-retention';
import { findSessionTranscript } from '../services/claude/transcript-files';
import { validateString, toSettingsIpcError } from '../utils/ipc-helpers';
import logger from '../utils/logger';

export function setupClaudeSessionsIPC(): void {
  // Asked before a prompt resumes a session: one that is gone is not resumed.
  ipcMain.handle(IPC_CHANNELS.CLAUDE_SESSION_EXISTS, async (_event, sessionId: string) => {
    try {
      validateString(sessionId, 'Session ID');
      return findSessionTranscript(sessionId) !== null;
    } catch (error) {
      logger.error('Failed to look for a Claude Code session', { error });
      throw toSettingsIpcError('Failed to look for the Claude Code session', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_GET_SESSION_RETENTION, async () => {
    try {
      return await readSessionRetention();
    } catch (error) {
      logger.error('Failed to read how long Claude Code keeps sessions', { error });
      throw toSettingsIpcError("Failed to read Claude Code's session retention", error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_SET_SESSION_RETENTION, async (_event, days: number) => {
    try {
      if (typeof days !== 'number' || !Number.isInteger(days) || days < 1) {
        throw new ValidationError('days must be a whole number, at least 1', 'days', ERROR_CODES.VALIDATION_TYPE_MISMATCH);
      }
      return await writeSessionRetention(days);
    } catch (error) {
      logger.error('Failed to set how long Claude Code keeps sessions', { error, days });
      throw toSettingsIpcError("Failed to set Claude Code's session retention", error);
    }
  });

  logger.info('Claude sessions IPC handlers registered');
}
