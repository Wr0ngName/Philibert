/**
 * Service for managing conversation persistence.
 *
 * A discussion is stored in two files (conversation-files): its details,
 * replaced whole and in one step, and its messages, appended to
 * (conversation-log). A save writes the messages that changed and the
 * details; nothing written is ever written over, so a save stopped at any
 * point loses at most what it was writing.
 */

import fs from 'node:fs';
import path from 'node:path';

import { isAfter, isArchived, newestFirst, summaryOf } from '../../shared/conversation-list';
import { generateId, ID_PREFIXES } from '../../shared/id';
import {
  AutoArchiveDays,
  ChatMessage,
  Conversation,
  ConversationListPage,
  ConversationListRequest,
  ConversationSummary,
  ConversationUpdate,
  ConversationWindow,
} from '../../shared/types';
import { MAIN_CONSTANTS } from '../constants/app';
import { appendToFile, replaceFile } from '../utils/durable-file';
import { readRanges } from '../utils/file-ranges';
import logger from '../utils/logger';
import { getConversationsPath, isPathWithin } from '../utils/paths';

import { findSessionTranscript } from './claude/transcript-files';
import {
  type ConversationDetails,
  DETAILS_SUFFIX,
  isDetailsFileName,
  isOneFileFormat,
  messagesFileOf,
} from './conversation-files';
import { ConversationIndex } from './conversation-index';
import {
  appendBatch, batchLocations, compactedLog, type LineLocation, recordLine, replay, TranscriptState,
} from './conversation-log';
import { type ConversionProgress, convertConversationFolder, convertOneFileDiscussion } from './conversation-migration';

/** A discussion as read from its two files. */
interface Loaded {
  details: ConversationDetails;
  messages: ChatMessage[];
  state: TranscriptState;
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
function storedUntil(ids: readonly string[], untilId: string | null): number {
  if (!untilId) return ids.length;
  const at = ids.indexOf(untilId);
  return at === -1 ? ids.length : at;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export class ConversationService {
  private conversationsDir: string;
  /** The discussions list's entries; see ConversationIndex. */
  private index: ConversationIndex;
  /**
   * Each conversation's writes, one after another. A write builds on what
   * the files hold, so two at once would each write what the other had not
   * seen — an archive landing during a save would be lost.
   *
   * Reads do not wait here: a page of history must not wait behind a save,
   * nor a jump to the end behind a page. See `writesQueued` for what a read
   * taken during a write may and may not be used for.
   */
  private writeChains = new Map<string, Promise<unknown>>();
  /**
   * Writes ever queued per conversation file. A read that saw no write
   * queued or running from its start to its end read files no write was
   * changing — only then is its write state kept (writeStates).
   */
  private writesQueued = new Map<string, number>();
  /**
   * What writing to each recently used discussion needs to know of its
   * messages file, so a save does not read it (TranscriptState). Kept for
   * a few, the most recently used last; one not kept is read again.
   */
  private writeStates = new Map<string, TranscriptState>();
  /**
   * Times each discussion's messages file was replaced or removed. Appends
   * leave every line where it was; these do not, so a page read by line
   * location (`view`) that saw this change reads the file again instead.
   */
  private fileGenerations = new Map<string, number>();

  constructor() {
    this.conversationsDir = getConversationsPath();
    this.index = new ConversationIndex(
      this.conversationsDir,
      // Beside the folder rather than in it: everything in it is a conversation.
      path.join(path.dirname(this.conversationsDir), 'conversation-index.json'),
    );
    this.ensureDirSync();
    logger.info('ConversationService initialized', { dir: this.conversationsDir });
  }

  /**
   * Bring the folder to the current layout: discussions in one file
   * converted, what stopped writes left behind removed. Called once at
   * startup, before anything reads the folder; see conversation-migration.
   */
  async upgradeStorage(onConverting?: (progress: ConversionProgress) => void): Promise<void> {
    try {
      await convertConversationFolder(this.conversationsDir, onConverting);
    } catch (error) {
      // Each discussion is converted when it is next opened instead.
      logger.error('Failed to check the conversations folder for the appended format', { error });
    }
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
      // Don't throw in constructor - let writes handle creation
    }
  }

  /**
   * Ensure the conversations directory exists and is writable (async version for writes)
   * Throws on error so writes can fail properly
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
   * Get the details file path for a conversation
   * Validates the ID to prevent path traversal attacks
   *
   * Security: We check the ORIGINAL path first to detect attacks,
   * then sanitize for safe filesystem operations
   */
  private getFilePath(id: string): string {
    // SECURITY: Check original input FIRST to detect path traversal attempts
    const originalPath = path.join(this.conversationsDir, `${id}${DETAILS_SUFFIX}`);
    if (!isPathWithin(originalPath, this.conversationsDir)) {
      logger.error('Path traversal attempt detected', { id });
      throw new Error('Invalid conversation ID: path traversal detected');
    }

    // Sanitize ID for safe filesystem operations
    const sanitizedId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (sanitizedId !== id) {
      logger.warn('Conversation ID was sanitized', { original: id, sanitized: sanitizedId });
    }

    return path.join(this.conversationsDir, `${sanitizedId}${DETAILS_SUFFIX}`);
  }

  /** The file a conversation is stored in, by name within the folder. */
  private fileNameOf(id: string): string {
    return path.basename(this.getFilePath(id));
  }

  /** Run a write of one conversation after its writes already under way; see writeChains. */
  private serialized<T>(id: string, work: () => Promise<T>): Promise<T> {
    // Keyed by file, which is what two writes would collide on.
    const key = this.fileNameOf(id);
    this.writesQueued.set(key, (this.writesQueued.get(key) ?? 0) + 1);
    const previous = this.writeChains.get(key) ?? Promise.resolve();
    // A write that failed was reported to its own caller; the next one runs.
    const run = previous.catch(() => undefined).then(work);
    const settled = run.catch(() => undefined);
    this.writeChains.set(key, settled);
    void settled.then(() => {
      if (this.writeChains.get(key) === settled) this.writeChains.delete(key);
    });
    return run;
  }

  /**
   * Wait for every write under way, or until `timeoutMs` has passed. For closing: the window is held open until what it handed over
   * is on disk.
   *
   * @returns false when it stopped waiting with work still under way.
   */
  async settleWrites(timeoutMs: number = MAIN_CONSTANTS.CONVERSATION.CLOSE_WRITE_WAIT_MS): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timed out'>((resolve) => {
      timer = setTimeout(() => resolve('timed out'), timeoutMs);
    });
    try {
      // A write can queue another behind it, so wait until none is left.
      while (this.writeChains.size > 0) {
        const outcome = await Promise.race([Promise.all([...this.writeChains.values()]), timedOut]);
        if (outcome === 'timed out') {
          logger.warn('Stopped waiting for conversation writes', {
            conversations: [...this.writeChains.keys()], timeoutMs,
          });
          return false;
        }
      }
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Forget where a discussion's lines are: its messages file was replaced or removed. */
  private messagesFileReplaced(id: string): void {
    this.writeStates.delete(id);
    this.fileGenerations.set(id, (this.fileGenerations.get(id) ?? 0) + 1);
  }

  /** Keep a discussion's write state, as the most recently used. */
  private rememberState(id: string, state: TranscriptState): void {
    this.writeStates.delete(id);
    this.writeStates.set(id, state);
    while (this.writeStates.size > MAIN_CONSTANTS.CONVERSATION.WRITE_STATES_KEPT) {
      const oldest = this.writeStates.keys().next().value as string;
      this.writeStates.delete(oldest);
    }
  }

  /**
   * A discussion's details file as stored — possibly a whole discussion in
   * the one-file layout — or null when there is none.
   */
  private async readDetailsFile(id: string): Promise<ConversationDetails | Conversation | null> {
    let text: string;
    try {
      text = await fs.promises.readFile(this.getFilePath(id), 'utf-8');
    } catch (error) {
      // A conversation that is not there is an answer: null.
      if (isMissing(error)) return null;
      // Anything else is a failure, and must not be answered with "there is
      // no such conversation": `update` builds on what this returns, and a
      // swallowed read error would treat a history it failed to read as a
      // new conversation. Reported here, handled by the caller.
      logger.error('Failed to read conversation', { id, error });
      throw error;
    }

    try {
      return JSON.parse(text) as ConversationDetails | Conversation;
    } catch (error) {
      logger.error('Failed to read conversation', { id, error });
      throw error;
    }
  }

  /** A discussion's messages file's content; empty when it has none yet. */
  private async readMessagesFile(id: string): Promise<string> {
    try {
      return await fs.promises.readFile(messagesFileOf(this.getFilePath(id)), 'utf-8');
    } catch (error) {
      // A discussion saved before it had any message has no messages file.
      if (isMissing(error)) return '';
      logger.error('Failed to read conversation messages', { id, error });
      throw error;
    }
  }

  /**
   * A discussion's details for a write to build on, or null when there is
   * none. One still in one file — copied into the folder while the app was
   * running — is converted first, so writes only ever meet the current
   * layout. Called only from within `serialized`.
   */
  private async detailsForWriting(id: string): Promise<ConversationDetails | null> {
    const stored = await this.readDetailsFile(id);
    if (!stored || !isOneFileFormat(stored)) return stored;
    this.messagesFileReplaced(id);
    return convertOneFileDiscussion(this.getFilePath(id), stored);
  }

  /** A discussion's write state, read from its file when not kept. Called only from within `serialized`. */
  private async stateForWriting(id: string): Promise<TranscriptState> {
    const kept = this.writeStates.get(id);
    if (kept) return kept;
    const { state, damaged } = replay(await this.readMessagesFile(id));
    if (damaged > 0) {
      logger.warn('Skipped lines of a messages file that a stopped write left unfinished', { id, damaged });
    }
    return state;
  }

  /** A discussion's details, or null; one still in one file converted first, in the write queue: a conversion is a write. */
  private async detailsForReading(id: string): Promise<ConversationDetails | null> {
    const stored = await this.readDetailsFile(id);
    return stored && isOneFileFormat(stored)
      ? this.serialized(id, () => this.detailsForWriting(id))
      : stored;
  }

  /**
   * A discussion's details and the ids of its messages in order, with a way
   * to read any stretch of them, or null when there is no such discussion.
   *
   * What paging needs: a page of 500 messages out of 68,000 reads those 500
   * lines (TranscriptState's line locations), not the whole messages file.
   * Locations are only known once the file was read whole in this process;
   * until then this reads it whole, once.
   *
   * The ids and their locations are taken in one step, before anything is
   * awaited, so a save landing meanwhile cannot shift them. A line can still
   * move — the file compacted, converted, removed — and then the stretch is
   * read from the whole file again; so it is when a line read does not hold
   * the message expected.
   */
  private async view(id: string): Promise<{
    details: ConversationDetails;
    ids: readonly string[];
    load: (from: number, to: number) => Promise<ChatMessage[]>;
  } | null> {
    // First: reading the details may convert the discussion, replacing its
    // messages file, and the snapshot must describe the file as it is after.
    const details = await this.detailsForReading(id);
    if (!details) return null;

    const kept = this.writeStates.get(id);
    if (!kept) {
      const loaded = await this.read(id);
      if (!loaded) return null;
      return {
        details: loaded.details,
        ids: loaded.messages.map((m) => m.id),
        load: async (from, to) => loaded.messages.slice(from, to),
      };
    }

    const generation = this.fileGenerations.get(id) ?? 0;
    const { ids, locations } = kept.snapshot();

    /** The stretch from the whole file, by id: what a location could not give. */
    const fromWholeFile = async (from: number, to: number, reason: string): Promise<ChatMessage[]> => {
      logger.info('Reading a page of a conversation from its whole messages file', { id, reason });
      const loaded = await this.read(id);
      const byId = new Map((loaded?.messages ?? []).map((m) => [m.id, m]));
      return ids.slice(from, to).flatMap((messageId) => byId.get(messageId) ?? []);
    };

    const load = async (from: number, to: number): Promise<ChatMessage[]> => {
      const wanted = locations.slice(from, to);
      if (wanted.some((location) => !location)) return fromWholeFile(from, to, 'a line not located');
      const replaced = () => (this.fileGenerations.get(id) ?? 0) !== generation;
      let lines: Buffer[];
      try {
        lines = await readRanges(messagesFileOf(this.getFilePath(id)), wanted as LineLocation[]);
      } catch (error) {
        // A replaced file can be shorter than where the lines were.
        if (replaced()) return fromWholeFile(from, to, 'the file was replaced');
        throw error;
      }
      if (replaced()) return fromWholeFile(from, to, 'the file was replaced');

      const messages: ChatMessage[] = [];
      for (const [i, bytes] of lines.entries()) {
        let record: { put?: ChatMessage } | undefined;
        try {
          record = JSON.parse(bytes.toString('utf-8')) as { put?: ChatMessage };
        } catch {
          record = undefined;
        }
        if (record?.put?.id !== ids[from + i]) return fromWholeFile(from, to, 'a line did not hold its message');
        messages.push(record.put);
      }
      return messages;
    };

    return { details, ids, load };
  }

  /**
   * A discussion's details and messages, or null. Not in the write queue;
   * see writeChains and writesQueued.
   */
  private async read(id: string): Promise<Loaded | null> {
    const key = this.fileNameOf(id);
    const queuedBefore = this.writesQueued.get(key) ?? 0;
    const quietBefore = !this.writeChains.has(key);

    const details = await this.detailsForReading(id);
    if (!details) return null;

    const { messages, state, damaged } = replay(await this.readMessagesFile(id));
    // Read while no write ran: the files were whole and still, so what was
    // read is what a write may build on. Otherwise an unfinished line is a
    // write still appending, not damage, and the state may already be old.
    const quiet = quietBefore && !this.writeChains.has(key) && (this.writesQueued.get(key) ?? 0) === queuedBefore;
    if (quiet) {
      if (damaged > 0) {
        logger.warn('Skipped lines of a messages file that a stopped write left unfinished', { id, damaged });
      }
      this.rememberState(id, state);
    }
    return { details, messages, state };
  }

  /**
   * Run a write, retrying transient failures — up to 3 attempts with
   * exponential backoff. Each attempt must be safe to repeat: the records it
   * appends replay the same twice (conversation-log), and a file it replaces
   * is replaced in one step.
   */
  private async withRetries(id: string, write: () => Promise<void>): Promise<void> {
    const maxRetries = MAIN_CONSTANTS.CONVERSATION.MAX_SAVE_RETRIES;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.ensureDirAsync();
        await write();
        return;
      } catch (error) {
        lastError = error as Error;
        logger.warn(`Conversation save attempt ${attempt} failed`, {
          id,
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

    logger.error('Failed to save conversation after retries', {
      id,
      attempts: maxRetries,
      error: lastError?.message,
    });
    throw lastError || new Error('Failed to save conversation');
  }

  /** Replace a discussion's details file, and record it in the index. */
  private async writeDetails(id: string, details: ConversationDetails): Promise<void> {
    await replaceFile(this.getFilePath(id), JSON.stringify(details, null, 2));
  }

  /**
   * Change a discussion's details, after its reads and writes under way,
   * and keep the index in step. Its messages are not read.
   *
   * @returns the details as now stored, or null when `change` changed nothing.
   */
  private changeDetails(
    id: string,
    change: (details: ConversationDetails) => Promise<boolean> | boolean,
  ): Promise<ConversationDetails | null> {
    return this.serialized(id, async () => {
      const details = await this.detailsForWriting(id);
      if (!details) throw new Error(`Conversation not found: ${id}`);
      if (!(await change(details))) return null;
      await this.withRetries(id, () => this.writeDetails(id, details));
      await this.index.noteWritten(this.fileNameOf(id), details);
      return details;
    });
  }

  /**
   * A page of the discussions list, newest first: the archived ones or the
   * others, after the cursor when one is given.
   *
   * The first page brings the index in line with the folder, so it is where a
   * change made outside the app shows up; the pages after it read the
   * entries as they stand, so a page does not cost a look at every file.
   */
  async listPage(request: ConversationListRequest): Promise<ConversationListPage> {
    if (!request.after || !this.index.isLoaded) await this.index.refresh();
    const now = Date.now();
    const matching = this.index
      .summaries()
      .filter((summary) => isArchived(summary, request.autoArchiveDays, now) === request.archived)
      .filter((summary) => !request.after || isAfter(summary, request.after))
      .sort(newestFirst);
    return {
      conversations: matching.slice(0, request.limit),
      hasMore: matching.length > request.limit,
    };
  }

  /** How many discussions are archived, by hand or for being inactive. */
  async archivedCount(autoArchiveDays: AutoArchiveDays): Promise<number> {
    if (!this.index.isLoaded) await this.index.refresh();
    const now = Date.now();
    return this.index.summaries().filter((summary) => isArchived(summary, autoArchiveDays, now)).length;
  }

  /** One discussion's list entry, or null when there is no such discussion. */
  async summary(id: string): Promise<ConversationSummary | null> {
    if (!this.index.isLoaded) await this.index.refresh();
    return this.index.summary(id);
  }

  /**
   * Archive a discussion, or bring it back. Bringing it back counts as
   * activity (`restoredAt`), so one archived for being inactive stays out of
   * the archive for as long as one just written in would.
   *
   * @returns its list entry as it now stands.
   */
  async setArchived(id: string, archived: boolean): Promise<ConversationSummary> {
    const details = await this.changeDetails(id, (stored) => {
      const now = Date.now();
      if (archived) {
        stored.archivedAt = now;
        delete stored.restoredAt;
      } else {
        delete stored.archivedAt;
        stored.restoredAt = now;
      }
      return true;
    });
    logger.info(archived ? 'Conversation archived' : 'Conversation brought back from the archive', { id });
    return summaryOf({ ...(details as ConversationDetails), messages: [] });
  }

  /** Save the index now; for quitting. */
  flushIndex(): Promise<void> {
    return this.index.flush();
  }

  /**
   * Search for a substring across conversation messages.
   *
   * When `scope` is `'current'`, only the named conversation is searched.
   * When `'all'`, every conversation is read once. The match is
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
      targets.push(currentConversationId);
    } else {
      try {
        const files = await fs.promises.readdir(this.conversationsDir);
        for (const file of files) {
          if (isDetailsFileName(file)) targets.push(file.slice(0, -DETAILS_SUFFIX.length));
        }
      } catch (error) {
        logger.error('Failed to list conversations for search', error);
        return [];
      }
    }

    for (const id of targets) {
      if (results.length >= limit) break;
      try {
        const loaded = await this.read(id);
        if (!loaded) continue;
        const title = loaded.details.title || loaded.details.id;
        for (const msg of loaded.messages) {
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
            conversationId: loaded.details.id,
            conversationTitle: title,
            messageId: msg.id,
            role: msg.role,
            snippet,
            timestamp: msg.timestamp,
          });
        }
      } catch (error) {
        logger.debug('Skipped unreadable conversation during search', { id, error });
      }
    }

    // Newest first
    results.sort((a, b) => b.timestamp - a.timestamp);
    return results;
  }

  /**
   * Get a single conversation by ID, with all its messages.
   *
   * Null when there is no such conversation; a conversation that cannot be
   * read is an error, never null — see readDetailsFile.
   */
  async get(id: string): Promise<Conversation | null> {
    const loaded = await this.read(id);
    return loaded ? { ...loaded.details, messages: loaded.messages } : null;
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
   * the order given. Only messages that differ from their stored version are
   * written: the renderer sends its whole window, and most of it is unchanged.
   */
  update(update: ConversationUpdate): Promise<void> {
    return this.serialized(update.id, () => this.applyUpdate(update));
  }

  private async applyUpdate(update: ConversationUpdate): Promise<void> {
    const { id } = update;
    const file = this.getFilePath(id);
    const stored = await this.detailsForWriting(id);

    let state: TranscriptState;
    if (stored) {
      state = await this.stateForWriting(id);
    } else {
      state = new TranscriptState();
      // What is left of a discussion deleted with this id is not this one's.
      this.messagesFileReplaced(id);
      await fs.promises.unlink(messagesFileOf(file)).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    }
    // Changed below as the records are made; dropped again if writing them fails.
    this.writeStates.delete(id);
    const storedCount = state.size;

    // The lines to append, each with the message it puts, if any.
    const batch: Array<{ line: string; putId?: string }> = [];
    let truncated = false;
    if (update.truncateFromId) {
      if (state.cut(update.truncateFromId)) {
        batch.push({ line: recordLine({ cut: update.truncateFromId }) });
        truncated = true;
      } else {
        // The anchor is gone, so what "from" means cannot be known. Dropping
        // nothing is the recoverable mistake; dropping everything is not.
        logger.warn('Truncation anchor not found — keeping the stored history', {
          id,
          truncateFromId: update.truncateFromId,
          storedCount,
        });
      }
    }

    let added = 0;
    let changed = 0;
    let unchanged = 0;
    for (const message of update.upsert) {
      const line = recordLine({ put: message });
      const outcome = state.put(message, line);
      if (outcome === 'unchanged') {
        unchanged += 1;
        continue;
      }
      batch.push({ line, putId: message.id });
      if (outcome === 'added') added += 1;
      else changed += 1;
    }

    const customTitle = update.customTitle ?? stored?.customTitle;
    const base: ConversationDetails = stored ?? {
      id,
      title: '',
      workingDirectory: update.workingDirectory,
      createdAt: update.createdAt ?? Date.now(),
      updatedAt: update.updatedAt,
    };
    const details: ConversationDetails = {
      ...base,
      workingDirectory: update.workingDirectory || base.workingDirectory,
      updatedAt: update.updatedAt,
      // Listed under the title its first message gives until renamed, as
      // summaryOf decides — kept here so the list need not read messages.
      title: (!customTitle && state.firstUserTitle) || (update.title ?? base.title),
      ...(update.customTitle !== undefined ? { customTitle: update.customTitle } : {}),
      ...(update.createdAt !== undefined ? { createdAt: base.createdAt || update.createdAt } : {}),
      ...(update.sdkSessionId !== undefined ? { sdkSessionId: update.sdkSessionId } : {}),
      ...(update.executionMode !== undefined ? { executionMode: update.executionMode } : {}),
      ...(update.lastSessionUsage !== undefined ? { lastSessionUsage: update.lastSessionUsage } : {}),
      ...(update.sessionPermissions !== undefined ? { sessionPermissions: update.sessionPermissions } : {}),
      ...(update.taskList !== undefined ? { taskList: update.taskList } : {}),
    };

    logger.info('Applying conversation update', {
      id,
      storedCount,
      added,
      changed,
      unchanged,
      truncated: truncated ? update.truncateFromId : 'none',
      resultCount: state.size,
    });

    const lines = batch.map((entry) => entry.line);
    const messagesFile = messagesFileOf(file);
    let locations: LineLocation[] = [];
    await this.withRetries(id, async () => {
      // Messages first, details last: the details file is what makes a
      // discussion exist, so a reader never finds one without the messages
      // it was saved with.
      if (lines.length > 0) {
        await appendToFile(messagesFile, appendBatch(lines));
        // The file ends with this batch: writes to it run one at a time.
        // Taken from the file rather than counted, so a batch an earlier
        // attempt half-wrote cannot shift where these lines are.
        locations = batchLocations(lines, (await fs.promises.stat(messagesFile)).size);
      }
      await this.writeDetails(id, details);
    });
    batch.forEach((entry, i) => {
      if (entry.putId) state.locate(entry.putId, locations[i]);
    });
    state.records += lines.length;
    this.rememberState(id, state);
    await this.index.noteWritten(path.basename(file), details);

    await this.compactIfWorthIt(id, state);
  }

  /**
   * Rewrite a messages file to its live messages once replaced records
   * outnumber them — each save of a streaming answer replaces it. Done in
   * one step (durable-file); failing leaves the file as it was, still whole.
   * Called only from within `serialized`.
   */
  private async compactIfWorthIt(id: string, state: TranscriptState): Promise<void> {
    const replaced = state.records - state.size;
    if (replaced <= Math.max(MAIN_CONSTANTS.CONVERSATION.COMPACT_MIN_REPLACED, state.size)) return;

    const file = messagesFileOf(this.getFilePath(id));
    try {
      const { messages } = replay(await fs.promises.readFile(file, 'utf-8'));
      const compacted = compactedLog(messages);
      await replaceFile(file, compacted.text);
      this.messagesFileReplaced(id);
      this.rememberState(id, compacted.state);
      logger.info('Compacted a conversation messages file', { id, messages: messages.length, replaced });
    } catch (error) {
      logger.warn('Failed to compact a conversation messages file', { id, error });
    }
  }

  /**
   * A conversation's most recent `limit` messages, and how many are older.
   *
   * Opening a conversation reads this rather than the whole conversation, so
   * the renderer holds a window instead of a history that grows without
   * bound; and only those messages' lines are read (`view`), once the
   * discussion was read whole in this process.
   */
  async getWindow(id: string, limit: number): Promise<ConversationWindow | null> {
    const view = await this.view(id);
    if (!view) return null;

    const start = Math.max(0, view.ids.length - Math.max(0, limit));
    return {
      conversation: { ...view.details, messages: await view.load(start, view.ids.length) },
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
    const view = await this.view(id);
    if (!view) return null;

    const at = view.ids.indexOf(beforeId);
    if (at === -1) {
      logger.warn('Asked for messages before an id that is not stored', { id, beforeId });
      return { messages: [], olderCount: 0 };
    }

    const start = Math.max(0, at - Math.max(0, limit));
    return { messages: await view.load(start, at), olderCount: start };
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
    const view = await this.view(id);
    if (!view) return null;

    const at = view.ids.indexOf(afterId);
    if (at === -1) {
      logger.warn('Asked for messages after an id that is not stored', { id, afterId });
      return { messages: [], newerCount: 0 };
    }

    const stop = storedUntil(view.ids, untilId);
    const start = Math.min(at + 1, stop);
    const end = Math.min(stop, start + Math.max(0, limit));
    return { messages: await view.load(start, end), newerCount: stop - end };
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
    const view = await this.view(id);
    if (!view) return null;

    const at = view.ids.indexOf(messageId);
    if (at === -1) {
      logger.warn('Asked for messages around an id that is not stored', { id, messageId });
      return null;
    }

    const stop = storedUntil(view.ids, untilId);
    if (at >= stop) return null;
    const start = Math.max(0, at - Math.max(0, before));
    const end = Math.min(stop, at + 1 + Math.max(0, after));
    return { messages: await view.load(start, end), olderCount: start, newerCount: stop - end };
  }

  /**
   * Rename a conversation (updates the title)
   */
  async rename(id: string, newTitle: string): Promise<void> {
    await this.changeDetails(id, (details) => {
      // Update title and mark as custom (manually set)
      details.title = newTitle.trim();
      details.customTitle = true;
      return true;
    });
    logger.info('Conversation renamed', { id, newTitle: newTitle.slice(0, 30) });
  }

  /**
   * Delete a conversation: its details file first, which is what makes it a
   * discussion, then its messages. Should removing the messages fail, the
   * next start removes them (conversation-migration).
   */
  delete(id: string): Promise<void> {
    return this.serialized(id, async () => {
      const filePath = this.getFilePath(id);

      try {
        await fs.promises.unlink(filePath);
        logger.info('Conversation deleted', { id });
      } catch (error) {
        if (!isMissing(error)) {
          logger.error('Failed to delete conversation', { id, error });
          throw error;
        }
      }
      this.messagesFileReplaced(id);
      this.index.noteDeleted(path.basename(filePath));

      try {
        await fs.promises.unlink(messagesFileOf(filePath));
      } catch (error) {
        if (!isMissing(error)) {
          logger.warn('Failed to delete conversation messages; removed at the next start', { id, error });
        }
      }
    });
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
   * field in message records) — no lossy path reconstruction. Reads and
   * writes only each discussion's details, never its messages.
   *
   * Called once at startup.
   */
  async recoverSessionData(): Promise<void> {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return;

    const claudeDir = path.join(home, '.claude');

    try {
      await fs.promises.access(path.join(claudeDir, 'projects'));
    } catch {
      return;
    }

    try {
      const conversationFiles = await fs.promises.readdir(this.conversationsDir);
      let fixed = 0;

      for (const file of conversationFiles) {
        if (!isDetailsFileName(file)) continue;
        try {
          // The file is named by its conversation's id; see getFilePath.
          const changed = await this.changeDetails(file.slice(0, -DETAILS_SUFFIX.length), async (details) => {
            if (!details.sdkSessionId || !details.workingDirectory) return false;

            const sessionFilePath = findSessionTranscript(details.sdkSessionId, claudeDir);
            if (!sessionFilePath) return false; // session gone entirely — leave as-is

            // Read the actual CWD from the session .jsonl file
            const actualCwd = await this.readCwdFromSessionFile(sessionFilePath);
            if (!actualCwd) return false;

            // Only update if the stored CWD doesn't match the actual CWD
            if (details.workingDirectory === actualCwd) return false;

            logger.info('Recovering conversation CWD from session file', {
              conversationId: details.id,
              oldCwd: details.workingDirectory,
              newCwd: actualCwd,
            });
            details.workingDirectory = actualCwd;
            return true;
          });
          if (changed) fixed++;
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
