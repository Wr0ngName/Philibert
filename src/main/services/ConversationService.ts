/**
 * Service for managing conversation persistence
 */

import fs from 'node:fs';
import path from 'node:path';

import { CONVERSATION_CONSTANTS } from '../../shared/constants';
import { generateId, ID_PREFIXES } from '../../shared/id';
import { Conversation } from '../../shared/types';
import { MAIN_CONSTANTS } from '../constants/app';
import logger from '../utils/logger';
import { getConversationsPath, isPathWithin } from '../utils/paths';
import { generateTitleFromContent } from '../utils/stringUtils';

export class ConversationService {
  private conversationsDir: string;

  constructor() {
    this.conversationsDir = getConversationsPath();
    this.ensureDirSync();
    logger.info('ConversationService initialized', { dir: this.conversationsDir });
  }

  /**
   * Ensure the conversations directory exists (sync version for constructor)
   */
  private ensureDirSync(): void {
    try {
      if (!fs.existsSync(this.conversationsDir)) {
        fs.mkdirSync(this.conversationsDir, { recursive: true });
        logger.info('Created conversations directory', { dir: this.conversationsDir });
      }
    } catch (error) {
      logger.error('Failed to create conversations directory', { dir: this.conversationsDir, error });
      // Don't throw in constructor - let save() handle creation
    }
  }

  /**
   * Ensure the conversations directory exists and is writable (async version for save operations)
   * Throws on error so save operations can fail properly
   */
  private async ensureDirAsync(): Promise<void> {
    try {
      // Check if directory exists
      await fs.promises.access(this.conversationsDir);
    } catch {
      // Directory doesn't exist, create it
      try {
        await fs.promises.mkdir(this.conversationsDir, { recursive: true });
        logger.info('Created conversations directory', { dir: this.conversationsDir });
      } catch (error) {
        logger.error('Failed to create conversations directory', { dir: this.conversationsDir, error });
        throw error;
      }
    }

    // Verify directory is writable
    try {
      await fs.promises.access(this.conversationsDir, fs.constants.W_OK);
    } catch (error) {
      logger.error('Conversations directory is not writable', { dir: this.conversationsDir, error });
      throw new Error(`Conversations directory is not writable: ${this.conversationsDir}`, { cause: error });
    }
  }

  /**
   * Get the file path for a conversation
   * Validates the ID to prevent path traversal attacks
   *
   * Security: We check the ORIGINAL path first to detect attacks,
   * then sanitize for safe filesystem operations
   */
  private getFilePath(id: string): string {
    // SECURITY: Check original input FIRST to detect path traversal attempts
    const originalPath = path.join(this.conversationsDir, `${id}.json`);
    if (!isPathWithin(originalPath, this.conversationsDir)) {
      logger.error('Path traversal attempt detected', { id });
      throw new Error('Invalid conversation ID: path traversal detected');
    }

    // Sanitize ID for safe filesystem operations
    const sanitizedId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (sanitizedId !== id) {
      logger.warn('Conversation ID was sanitized', { original: id, sanitized: sanitizedId });
    }

    return path.join(this.conversationsDir, `${sanitizedId}.json`);
  }

  /**
   * List all conversations (metadata only)
   */
  async list(): Promise<Conversation[]> {
    try {
      const files = await fs.promises.readdir(this.conversationsDir);
      const conversations: Conversation[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) {
          continue;
        }

        try {
          const content = await fs.promises.readFile(
            path.join(this.conversationsDir, file),
            'utf-8'
          );
          const conversation = JSON.parse(content) as Conversation;
          // Return without full message content for list view
          conversations.push({
            ...conversation,
            messages: [], // Don't include messages in list
          });
        } catch (error) {
          logger.warn('Failed to parse conversation file', { file, error });
        }
      }

      // Sort by updated date, newest first
      conversations.sort((a, b) => b.updatedAt - a.updatedAt);

      return conversations;
    } catch (error) {
      logger.error('Failed to list conversations', error);
      return [];
    }
  }

  /**
   * Search for a substring across conversation messages.
   *
   * When `scope` is `'current'`, only the named conversation is searched.
   * When `'all'`, every conversation file is read once. The match is
   * case-insensitive, returns at most `limit` results, and each result
   * carries a short snippet trimmed around the first hit so the UI can
   * render a meaningful preview without sending whole messages over IPC.
   */
  async search(
    query: string,
    scope: 'current' | 'all',
    currentConversationId: string | null,
    limit = 100,
  ): Promise<Array<{
    conversationId: string;
    conversationTitle: string;
    messageId: string;
    role: string;
    snippet: string;
    timestamp: number;
  }>> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];

    const results: Array<{
      conversationId: string;
      conversationTitle: string;
      messageId: string;
      role: string;
      snippet: string;
      timestamp: number;
    }> = [];

    const targets: string[] = [];
    if (scope === 'current') {
      if (!currentConversationId) return [];
      targets.push(`${currentConversationId}.json`);
    } else {
      try {
        const files = await fs.promises.readdir(this.conversationsDir);
        for (const file of files) {
          if (file.endsWith('.json')) targets.push(file);
        }
      } catch (error) {
        logger.error('Failed to list conversations for search', error);
        return [];
      }
    }

    for (const file of targets) {
      if (results.length >= limit) break;
      try {
        const content = await fs.promises.readFile(
          path.join(this.conversationsDir, file),
          'utf-8',
        );
        const conv = JSON.parse(content) as Conversation;
        const title = conv.title || conv.id;
        for (const msg of conv.messages || []) {
          if (results.length >= limit) break;
          const text = msg.content || '';
          const lower = text.toLowerCase();
          const idx = lower.indexOf(needle);
          if (idx === -1) continue;

          // Snippet: ~80 chars around the first hit
          const start = Math.max(0, idx - 40);
          const end = Math.min(text.length, idx + needle.length + 40);
          const prefix = start > 0 ? '…' : '';
          const suffix = end < text.length ? '…' : '';
          const snippet = `${prefix}${text.slice(start, end)}${suffix}`;

          results.push({
            conversationId: conv.id,
            conversationTitle: title,
            messageId: msg.id,
            role: msg.role,
            snippet,
            timestamp: msg.timestamp,
          });
        }
      } catch (error) {
        logger.debug('Skipped unreadable conversation file during search', { file, error });
      }
    }

    // Newest first
    results.sort((a, b) => b.timestamp - a.timestamp);
    return results;
  }

  /**
   * Get a single conversation by ID
   */
  async get(id: string): Promise<Conversation | null> {
    const filePath = this.getFilePath(id);

    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return JSON.parse(content) as Conversation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to get conversation', { id, error });
      }
      return null;
    }
  }

  /**
   * Save a conversation with retry logic for transient failures
   * Retries up to 3 times with exponential backoff
   */
  async save(conversation: Conversation): Promise<void> {
    const filePath = this.getFilePath(conversation.id);
    const maxRetries = MAIN_CONSTANTS.CONVERSATION.MAX_SAVE_RETRIES;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Ensure directory exists before writing (async, throws on error)
        await this.ensureDirAsync();

        // Preserve updatedAt from the renderer (set to last message timestamp)
        const updated = {
          ...conversation,
        };

        // Generate title from first user message if not set
        if (!updated.title && updated.messages.length > 0) {
          const firstUserMessage = updated.messages.find((m) => m.role === 'user');
          if (firstUserMessage) {
            updated.title = generateTitleFromContent(
              firstUserMessage.content,
              CONVERSATION_CONSTANTS.TITLE_MAX_LENGTH
            );
          }
        }

        // Serialize and write atomically
        const content = JSON.stringify(updated, null, 2);
        await fs.promises.writeFile(filePath, content, 'utf-8');

        logger.debug('Conversation saved', { id: conversation.id, attempt });
        return; // Success, exit retry loop
      } catch (error) {
        lastError = error as Error;
        logger.warn(`Conversation save attempt ${attempt} failed`, {
          id: conversation.id,
          error: lastError.message,
          attempt,
          maxRetries,
        });

        // Don't retry for certain error types
        const errCode = (error as NodeJS.ErrnoException).code;
        if (errCode === 'EACCES' || errCode === 'EROFS') {
          // Permission denied or read-only filesystem - no point retrying
          break;
        }

        if (attempt < maxRetries) {
          // Exponential backoff: 100ms, 200ms, 400ms
          const delay = MAIN_CONSTANTS.CONVERSATION.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // All retries exhausted
    logger.error('Failed to save conversation after retries', {
      id: conversation.id,
      attempts: maxRetries,
      error: lastError?.message,
    });
    throw lastError || new Error('Failed to save conversation');
  }

  /**
   * Rename a conversation (updates the title)
   */
  async rename(id: string, newTitle: string): Promise<void> {
    const conversation = await this.get(id);
    if (!conversation) {
      throw new Error(`Conversation not found: ${id}`);
    }

    // Update title and mark as custom (manually set)
    conversation.title = newTitle.trim();
    conversation.customTitle = true;  // Mark as manually renamed
    await this.save(conversation);

    logger.info('Conversation renamed', { id, newTitle: newTitle.slice(0, 30) });
  }

  /**
   * Delete a conversation
   */
  async delete(id: string): Promise<void> {
    const filePath = this.getFilePath(id);

    try {
      await fs.promises.unlink(filePath);
      logger.info('Conversation deleted', { id });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to delete conversation', { id, error });
        throw error;
      }
    }
  }

  /**
   * Strip sdkSessionId from all persisted conversations.
   * Called when auth is invalidated so stale session IDs don't survive restart.
   */
  async clearAllSessionIds(): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.conversationsDir);
      let cleared = 0;

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(this.conversationsDir, file);
        try {
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const conversation = JSON.parse(content) as Conversation;
          if (conversation.sdkSessionId) {
            delete conversation.sdkSessionId;
            await fs.promises.writeFile(filePath, JSON.stringify(conversation, null, 2), 'utf-8');
            cleared++;
          }
        } catch (err) {
          logger.warn('Failed to clear session ID from conversation file', { file, error: err });
        }
      }

      if (cleared > 0) {
        logger.info('Cleared persisted SDK session IDs', { cleared });
      }
    } catch (err) {
      logger.error('Failed to clear all session IDs', { error: err });
    }
  }

  /**
   * Recover conversations whose stored CWD doesn't match where the CLI
   * actually placed the session file.
   *
   * Targets a specific scenario: conversation stores the global working
   * directory but the session was created under a subdirectory CWD
   * (e.g. a channel-session subpath). Only touches broken conversations —
   * if the session file is already found under the stored CWD, nothing changes.
   *
   * Reads the actual CWD directly from the session .jsonl file (the `cwd`
   * field in message records) — no lossy path reconstruction.
   *
   * Called once at startup.
   */
  async recoverSessionData(): Promise<void> {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return;

    const claudeProjectsDir = path.join(home, '.claude', 'projects');

    try {
      await fs.promises.access(claudeProjectsDir);
    } catch {
      return;
    }

    try {
      const projectDirs = await fs.promises.readdir(claudeProjectsDir);
      const conversationFiles = await fs.promises.readdir(this.conversationsDir);
      let fixed = 0;

      for (const file of conversationFiles) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(this.conversationsDir, file);
        try {
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const conversation = JSON.parse(content) as Conversation;
          if (!conversation.sdkSessionId || !conversation.workingDirectory) continue;

          // Search ALL project dirs for the session file by its unique ID.
          // This avoids replicating the CLI's internal CWD escaping logic.
          const sessionFileName = `${conversation.sdkSessionId}.jsonl`;
          let sessionFilePath: string | null = null;
          for (const dir of projectDirs) {
            const candidate = path.join(claudeProjectsDir, dir, sessionFileName);
            if (fs.existsSync(candidate)) {
              sessionFilePath = candidate;
              break;
            }
          }

          if (!sessionFilePath) continue; // session gone entirely — leave as-is

          // Read the actual CWD from the session .jsonl file
          const actualCwd = await this.readCwdFromSessionFile(sessionFilePath);
          if (!actualCwd) continue;

          // Only update if the stored CWD doesn't match the actual CWD
          if (conversation.workingDirectory === actualCwd) continue;

          logger.info('Recovering conversation CWD from session file', {
            conversationId: conversation.id,
            oldCwd: conversation.workingDirectory,
            newCwd: actualCwd,
          });
          conversation.workingDirectory = actualCwd;
          await fs.promises.writeFile(filePath, JSON.stringify(conversation, null, 2), 'utf-8');
          fixed++;
        } catch (err) {
          logger.warn('Failed to check conversation for recovery', { file, error: err });
        }
      }

      if (fixed > 0) {
        logger.info('Session data recovery complete', { fixed });
      }
    } catch (err) {
      logger.error('Failed to recover session data', { error: err });
    }
  }

  /**
   * Read the `cwd` field from the first message in a CLI session .jsonl file.
   */
  private async readCwdFromSessionFile(sessionPath: string): Promise<string | null> {
    try {
      const content = await fs.promises.readFile(sessionPath, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (typeof record.cwd === 'string' && record.cwd) return record.cwd;
        } catch {
          // skip unparseable lines
        }
      }
    } catch (err) {
      logger.warn('Failed to read CWD from session file', { sessionPath, error: err });
    }
    return null;
  }

  /**
   * Create a new conversation
   */
  create(workingDirectory: string): Conversation {
    return {
      id: generateId(ID_PREFIXES.CONVERSATION),
      title: '',
      workingDirectory,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
}

export default ConversationService;
