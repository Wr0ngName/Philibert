/**
 * Service for managing conversation persistence
 */

import fs from 'node:fs';
import path from 'node:path';

import { CONVERSATION_CONSTANTS } from '../../shared/constants';
import { generateId, ID_PREFIXES } from '../../shared/id';
import {
  BackgroundTaskInfo,
  ChatMessage,
  Conversation,
  ConversationUpdate,
  ConversationWindow,
  ToolUseInfo,
} from '../../shared/types';
import { MAIN_CONSTANTS } from '../constants/app';
import logger from '../utils/logger';
import { getConversationsPath, isPathWithin } from '../utils/paths';
import { generateTitleFromContent } from '../utils/stringUtils';

/** How an incoming write differs from the one before it, when it does. */
export interface WriteAnomaly {
  reason: string;
  /** Where the two transcripts stop agreeing, when that is what happened. */
  divergedAt?: number;
  previousCount: number;
  incomingCount: number;
}

/**
 * How a write differs from the last one, when the difference looks like lost
 * history. Null when it looks like a conversation growing, which is almost
 * always.
 *
 * It only ever reports. Its predecessor refused the write instead, and the
 * refusal is what lost the messages: the save threw, the retry loop gave up,
 * the file kept its previous content, and everything since the last
 * successful save existed only in the renderer until the conversation was
 * switched away from. The in-memory list is what the user is looking at —
 * declining to write it cannot preserve anything, it can only lose it.
 *
 * It also stops short of calling a divergence corruption, because the app has
 * two paths that legitimately remove a message from the middle of a history:
 * `splitStreamingForTool` drops an empty streaming placeholder, and
 * `removeBackgroundTaskMessageByToolUseId` drops a task message the tool_use
 * indicator has taken over. The refusing version treated "agrees on the
 * common prefix" as the definition of a safe write and so had no room for
 * either of them.
 *
 * Compared against the ids this process last wrote rather than against the
 * file: no per-save read, which on a twelve-thousand-message conversation was
 * itself not free. The cost is that a fresh process has nothing to compare
 * against until it has written once — right for something that only warns.
 */
export function describeSuspiciousWrite(
  previous: string[] | undefined,
  next: string[],
): WriteAnomaly | null {
  if (!previous || previous.length === 0) return null;

  const common = Math.min(previous.length, next.length);
  for (let i = 0; i < common; i += 1) {
    if (previous[i] !== next[i]) {
      return {
        reason: `the history diverges at message ${i} (was ${previous[i]}, now ${next[i]})`,
        divergedAt: i,
        previousCount: previous.length,
        incomingCount: next.length,
      };
    }
  }

  if (next.length < previous.length) {
    return {
      reason: `the history shrank from ${previous.length} to ${next.length} messages`,
      previousCount: previous.length,
      incomingCount: next.length,
    };
  }

  return null;
}

/**
 * A stored transcript with any repeated message id dropped, keeping the first.
 *
 * Done where the file enters the app, so nothing downstream has to cope. A
 * message id is the identity of a row everywhere above here: it keys the
 * upsert that writes it, the height the virtual list measures it at, and the
 * anchor a page of history is fetched against. Two messages sharing one makes
 * all three ambiguous — the same message shown twice, measured as two rows,
 * and written twice on the next save.
 *
 * Nothing this app does produces a duplicate: an upsert is keyed by id, so a
 * repeat replaces rather than appends. A file can still arrive with one — a
 * hand edit, a restore from a partial copy, a version of this app that had a
 * bug — and "the conversation file is slightly wrong" should cost the user a
 * dropped duplicate, not a transcript that cannot be paged through. The next
 * write stores the cleaned list, so the file repairs itself.
 *
 * The window code deliberately does NOT dedupe. With pages anchored by id,
 * what comes back is always strictly outside the window, so an overlap can
 * only mean a duplicate in the file — which is this function's business, and
 * which a filter inside the window could not fix anyway: the duplicate can
 * sit inside a single page, where "already held" is not yet true of it.
 */
function withoutRepeatedIds(id: string, messages: ChatMessage[] | undefined): ChatMessage[] {
  if (!messages || messages.length === 0) return messages ?? [];

  const seen = new Set<string>();
  const kept: ChatMessage[] = [];
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    kept.push(message);
  }

  if (kept.length !== messages.length) {
    logger.warn('Dropped repeated message ids from a stored conversation', {
      id, stored: messages.length, kept: kept.length,
    });
  }
  return kept;
}

/** A call as 0.25.1-rc.2 and rc.3 stored it: an Agent call's record was `agentTask`. */
type StoredToolUse = ToolUseInfo & { agentTask?: BackgroundTaskInfo };

/**
 * A stored transcript with each task row folded into the call that started
 * the task, so the task has one row: its call (see ToolUseInfo.task).
 *
 * Done where the file enters the app, like withoutRepeatedIds, so nothing
 * downstream has to know older files differ; the next write stores the
 * repaired list. Two things older versions wrote:
 *
 * - A background command drawn twice — its call, and a task row of its own,
 *   because the first notice of the task did not name the call. The row's
 *   record moves onto the call and the row goes. Matched by id only: the
 *   row's task id (the call's block id, which that first notice used as the
 *   task's id) or its tool_use id. A row matching no call here is a task with
 *   no call in the transcript, and stays.
 * - An Agent call's record under `agentTask` (rc.2, rc.3), read as `task`.
 */
function withTaskRowsOnCalls(id: string, messages: ChatMessage[]): ChatMessage[] {
  let renamed = 0;
  const named = messages.map((message) => {
    const toolUse = message.toolUse as StoredToolUse | undefined;
    if (!toolUse?.agentTask) return message;
    renamed++;
    const { agentTask, ...rest } = toolUse;
    return { ...message, toolUse: { ...rest, task: rest.task ?? agentTask } };
  });

  const callIds = new Set(
    named.flatMap((message) => (message.toolUse?.toolUseBlockId ? [message.toolUse.toolUseBlockId] : [])),
  );
  const rowsByCall = new Map<string, BackgroundTaskInfo>();
  const kept = named.filter((message) => {
    const row = message.backgroundTask;
    if (!row) return true;
    const callId = [row.taskId, row.toolUseId].find((candidate) => candidate !== undefined && callIds.has(candidate));
    if (callId === undefined) return true;
    rowsByCall.set(callId, row);
    return false;
  });

  if (renamed === 0 && rowsByCall.size === 0) return messages;
  logger.info('Folded task rows of a stored conversation into their calls', {
    id, folded: rowsByCall.size, renamed,
  });
  return kept.map((message) => {
    const toolUse = message.toolUse;
    const row = toolUse?.toolUseBlockId ? rowsByCall.get(toolUse.toolUseBlockId) : undefined;
    // A call that already has a record keeps it: the row was a second copy.
    return toolUse && row && !toolUse.task ? { ...message, toolUse: { ...toolUse, task: row } } : message;
  });
}

/**
 * Where the stored messages a window may be given end: at `untilId`, the
 * first message of a turn the renderer holds in memory apart from its
 * window, or at the end of the conversation.
 *
 * That turn may be stored in part — a save mid-turn writes it as far as it
 * has got — and the renderer's copy is ahead of the stored one. A page or
 * stretch running into it would hand back a stale copy of what is already
 * held, and count it a second time among the messages still to come.
 */
function storedUntil(all: readonly ChatMessage[], untilId: string | null): number {
  if (!untilId) return all.length;
  const at = all.findIndex((m) => m.id === untilId);
  return at === -1 ? all.length : at;
}

export class ConversationService {
  private conversationsDir: string;
  /**
   * Message ids of the last successful write per conversation, for the check
   * above. A long conversation costs a few hundred kilobytes here, against
   * reading and parsing megabytes of JSON on every single save.
   */
  private lastWrittenIds: Map<string, string[]> = new Map();

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
      const conversation = JSON.parse(content) as Conversation;
      const messages = withTaskRowsOnCalls(id, withoutRepeatedIds(id, conversation.messages));
      return { ...conversation, messages };
    } catch (error) {
      // A conversation that is not there is an answer: null.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;

      // Anything else is a failure, and must not be answered with "there is
      // no such conversation". `update` builds on what this returns, so a
      // swallowed read error meant an unreadable file was treated as a new
      // conversation — and the next write would replace a history it had
      // simply failed to read. Reported here, handled by the caller.
      logger.error('Failed to read conversation', { id, error });
      throw error;
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

        // Say something when a write looks like it loses history, and write it
        // anyway. See describeSuspiciousWrite for why it cannot be a refusal:
        // refusing is what lost messages.
        const ids = updated.messages.map((m) => m.id);
        const anomaly = describeSuspiciousWrite(this.lastWrittenIds.get(conversation.id), ids);
        if (anomaly) {
          logger.warn('Conversation write looks like it loses history — writing it anyway', {
            id: conversation.id,
            ...anomaly,
          });
        }

        // Serialize and write atomically
        const content = JSON.stringify(updated, null, 2);
        await fs.promises.writeFile(filePath, content, 'utf-8');
        this.lastWrittenIds.set(conversation.id, ids);

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
   * Apply a change to a stored conversation — the renderer's only way to
   * write one.
   *
   * See `ConversationUpdate` for why writes are changes rather than whole
   * conversations. The short version: a write that carries the entire message
   * list makes the file only as complete as the renderer's memory, so memory
   * can never be bounded without risking the loss this app has already
   * shipped once. Here the stored transcript can only grow, except where
   * `truncateFromId` says otherwise.
   *
   * Upsert is positional-stable: a message already stored is replaced where it
   * is, so an edit cannot reorder history, and one that is new is appended in
   * the order given.
   *
   * Everything else — the retry loop, the title fallback, the suspicious-write
   * report — is shared with `save`, which does the writing.
   */
  async update(update: ConversationUpdate): Promise<void> {
    const stored = await this.get(update.id);

    const base: Conversation = stored ?? {
      id: update.id,
      title: update.title ?? '',
      workingDirectory: update.workingDirectory,
      messages: [],
      createdAt: update.createdAt ?? Date.now(),
      updatedAt: update.updatedAt,
    };

    let messages = [...base.messages];

    if (update.truncateFromId) {
      const cut = messages.findIndex((m) => m.id === update.truncateFromId);
      if (cut === -1) {
        // The anchor is gone, so what "from" means cannot be known. Dropping
        // nothing is the recoverable mistake; dropping everything is not.
        logger.warn('Truncation anchor not found — keeping the stored history', {
          id: update.id,
          truncateFromId: update.truncateFromId,
          storedCount: messages.length,
        });
      } else {
        messages = messages.slice(0, cut);
      }
    }

    const indexById = new Map<string, number>();
    messages.forEach((message, index) => indexById.set(message.id, index));

    let added = 0;
    let replaced = 0;
    for (const message of update.upsert) {
      const at = indexById.get(message.id);
      if (at === undefined) {
        indexById.set(message.id, messages.length);
        messages.push(message);
        added += 1;
      } else {
        messages[at] = message;
        replaced += 1;
      }
    }

    const merged: Conversation = {
      ...base,
      messages,
      workingDirectory: update.workingDirectory || base.workingDirectory,
      updatedAt: update.updatedAt,
      ...(update.title !== undefined ? { title: update.title } : {}),
      ...(update.customTitle !== undefined ? { customTitle: update.customTitle } : {}),
      ...(update.createdAt !== undefined ? { createdAt: base.createdAt || update.createdAt } : {}),
      ...(update.sdkSessionId !== undefined ? { sdkSessionId: update.sdkSessionId } : {}),
      ...(update.executionMode !== undefined ? { executionMode: update.executionMode } : {}),
      ...(update.lastSessionUsage !== undefined ? { lastSessionUsage: update.lastSessionUsage } : {}),
      ...(update.sessionPermissions !== undefined ? { sessionPermissions: update.sessionPermissions } : {}),
      ...(update.taskList !== undefined ? { taskList: update.taskList } : {}),
    };

    logger.info('Applying conversation update', {
      id: update.id,
      storedCount: base.messages.length,
      added,
      replaced,
      truncated: update.truncateFromId ?? 'none',
      resultCount: messages.length,
    });

    await this.save(merged);
  }

  /**
   * A conversation's most recent `limit` messages, and how many are older.
   *
   * Opening a conversation reads this rather than the whole file, so the
   * renderer holds a window instead of a history that grows without bound.
   * The file is still parsed in full here — it is one JSON document — but
   * that is a transient cost in this process rather than a permanent one in
   * the renderer.
   */
  async getWindow(id: string, limit: number): Promise<ConversationWindow | null> {
    const conversation = await this.get(id);
    if (!conversation) return null;

    const all = conversation.messages ?? [];
    const take = Math.max(0, limit);
    const start = Math.max(0, all.length - take);

    return {
      conversation: { ...conversation, messages: all.slice(start) },
      olderCount: start,
    };
  }

  /**
   * The `limit` messages stored immediately before `beforeId`.
   *
   * What scrolling to the top of the window asks for. Keyed by the id the
   * renderer currently holds at the top of its window rather than by an
   * index, so a conversation that grew in between cannot shift the page under
   * it.
   */
  async getOlder(
    id: string,
    beforeId: string,
    limit: number,
  ): Promise<{ messages: ChatMessage[]; olderCount: number } | null> {
    const conversation = await this.get(id);
    if (!conversation) return null;

    const all = conversation.messages ?? [];
    const at = all.findIndex((m) => m.id === beforeId);
    if (at === -1) {
      logger.warn('Asked for messages before an id that is not stored', { id, beforeId });
      return { messages: [], olderCount: 0 };
    }

    const start = Math.max(0, at - Math.max(0, limit));
    return { messages: all.slice(start, at), olderCount: start };
  }

  /**
   * The `limit` messages stored immediately after `afterId`.
   *
   * The other direction of the same window: reading back through a long
   * conversation unloads the newest messages to keep the loaded set bounded,
   * and reading forward again has to be able to fetch them. Keyed by id for
   * the same reason as `getOlder` — a conversation that grew in between cannot
   * shift the page under the reader. Stops at `untilId`; see `storedUntil`.
   */
  async getNewer(
    id: string,
    afterId: string,
    limit: number,
    untilId: string | null = null,
  ): Promise<{ messages: ChatMessage[]; newerCount: number } | null> {
    const conversation = await this.get(id);
    if (!conversation) return null;

    const all = conversation.messages ?? [];
    const at = all.findIndex((m) => m.id === afterId);
    if (at === -1) {
      logger.warn('Asked for messages after an id that is not stored', { id, afterId });
      return { messages: [], newerCount: 0 };
    }

    const stop = storedUntil(all, untilId);
    const start = Math.min(at + 1, stop);
    const end = Math.min(stop, start + Math.max(0, limit));
    return { messages: all.slice(start, end), newerCount: stop - end };
  }

  /**
   * A window of the conversation centred on one message: up to `before`
   * messages ahead of it, the message, and up to `after` behind it.
   *
   * What opening a search hit needs. The renderer holds a window of the
   * conversation, so a hit further back than that window cannot be scrolled
   * to — it has to be loaded first, and loading everything between the hit
   * and the window would throw away the bound the window exists for.
   *
   * Null when the conversation or the message is not stored — or when the
   * message lies at or past `untilId`, inside the turn the renderer holds.
   */
  async getAround(
    id: string,
    messageId: string,
    before: number,
    after: number,
    untilId: string | null = null,
  ): Promise<{ messages: ChatMessage[]; olderCount: number; newerCount: number } | null> {
    const conversation = await this.get(id);
    if (!conversation) return null;

    const all = conversation.messages ?? [];
    const at = all.findIndex((m) => m.id === messageId);
    if (at === -1) {
      logger.warn('Asked for messages around an id that is not stored', { id, messageId });
      return null;
    }

    const stop = storedUntil(all, untilId);
    if (at >= stop) return null;
    const start = Math.max(0, at - Math.max(0, before));
    const end = Math.min(stop, at + 1 + Math.max(0, after));
    return { messages: all.slice(start, end), olderCount: start, newerCount: stop - end };
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
