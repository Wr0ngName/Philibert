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
