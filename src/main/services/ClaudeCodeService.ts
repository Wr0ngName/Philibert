/**
 * Service for integrating with @anthropic-ai/claude-code
 *
 * Uses the Claude Code SDK query() function with AsyncIterable prompt
 * for persistent sessions. This keeps the SDK subprocess alive between
 * user turns. Background task notifications (task_started, task_progress,
 * task_updated, task_notification) flow natively through the SDK stream
 * between turns — no polling required.
 *
 * Supports both OAuth tokens (Pro/Max) and API keys.
 *
 * MULTI-INSTANCE SUPPORT:
 * This service supports multiple concurrent SDK sessions, one per conversation.
 * Each conversation gets its own Query instance, AsyncChannel, and message handler.
 * Resource limits prevent memory exhaustion (default: 5 concurrent sessions).
 *
 * This service orchestrates the following modules:
 * - PermissionManager: Handles tool permission requests
 * - SDKMessageHandler: Processes SDK messages
 * - AuthValidator: Validates authentication credentials
 * - ErrorHandler: Converts errors to user-friendly messages
 */

import * as fs from 'fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { getSubagentMessages, query } from '@anthropic-ai/claude-agent-sdk';
import type {
  AccountInfo,
  AgentInfo as SDKAgentInfo,
  ModelInfo as SDKModelInfo,
  Query,
  SDKUserMessage,
  SlashCommand,
  SpawnOptions,
  SpawnedProcess,
  ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';
import { BrowserWindow } from 'electron';

import { resolveEffortForSelection } from '../../shared/effort';
import {
  familyKeyOf,
  formatModelDisplayName,
  formatModelId,
  isRealModelId,
  isSameModel,
  modelVersionRank,
  parseModelId,
  stripContextVariant,
  stripDateSuffix,
} from '../../shared/model-id';
import {
  AgentInfo,
  AgentRun,
  IPC_CHANNELS,
  PendingAction,
  ActionResponse,
  SlashCommandInfo,
  EffortLevel,
  LiveBackgroundTask,
  ModelInfo,
  RewindOutcome,
  RewindPreview,
  RewindScope,
  TaskNotification,
  SessionUsage,
  ToolCaptureData,
  MAX_CONCURRENT_QUERIES,
  SessionPermissionEntry,
  MessageImage,
  ImageMediaType,
  type ChatMessage,
  type PromptDeliveryState,
  type ClaudeAccount,
  type TaskOutputChunk,
} from '../../shared/types';
import { AsyncChannel } from '../utils/AsyncChannel';
import { createSender } from '../utils/ipc-helpers';
import logger from '../utils/logger';
import { ClaudeCliPaths, WindowsPaths } from '../utils/resourcePaths';

import ConfigService from './ConfigService';
import { ImageStore } from './ImageStore';
import NotificationService from './NotificationService';
import { ChannelService } from './channel';
import {
  PermissionManager,
  SDKMessageHandler,
  AuthValidator,
  ErrorHandler,
  SessionPermissionCache,
} from './claude';
import { resultEndsOurTurn, resolveResultError } from './claude/SDKMessageHandler';
import type { ModelReportSource, ModelSubstitutionEvent, SubagentActivity } from './claude/SDKMessageHandler';
import {
  attachTranscriptImages, cliTempRoot, locateTaskOutput, readTaskOutput, transcriptToMessages, type FoundImages,
} from './claude/task-output';
import { writeToolResultFile } from './claude/tool-result-file';
import type { ExtractedImage } from './claude/tool-result-images';

/**
 * An entry in the known-model catalog. `minor` is absent for the Claude 5
 * generation, whose IDs carry a single version segment (`claude-opus-5`).
 */
interface CatalogEntry {
  family: string;
  major: number;
  minor?: number;
  context: string;
}

/**
 * Provenance stamped on every user message this app sends.
 *
 * The SDK is explicit that "a host wrapping keyboard input must stamp
 * {kind:'human'} explicitly — absent origin is treated as unattributed and
 * fails closed at strict isHuman() trust gates". Every message we push comes
 * from the person typing in the chat box, so without this the CLI cannot tell
 * our turns apart from harness-driven ones.
 */
const HUMAN_ORIGIN = { kind: 'human' } as const;

/**
 * The task-list tools, named explicitly because the CLI no longer offers them.
 *
 * The todo panel is built from TaskCreate and TaskUpdate calls, and it stopped
 * being able to show anything because those tools left the CLI's base tool
 * set. Measured across CLI versions, same SDK, same options:
 *
 *   2.1.220  32 tools  Task, TaskCreate, TaskGet, TaskList, TaskOutput, TaskStop, TaskUpdate
 *   2.1.278  28 tools  Task, TaskStop
 *   2.1.280  28 tools  Task, TaskStop   ← the version this app bundles
 *
 * Naming them in `allowedTools` adds them back (28 → 34 in the same probe).
 * NOT `tools`, which replaces the base set rather than extending it and left
 * the session with 14 tools, no Bash or Read among them.
 *
 * Two deliberate exclusions:
 *
 *  - Grep and Glob are also missing from the base set and also restorable
 *    this way, but a bare `allowedTools` entry auto-approves that tool before
 *    `canUseTool` is consulted — the SDK warns about exactly this. Restoring
 *    file-reading tools by a route that bypasses the permission prompt is a
 *    different decision from fixing the todo panel, and is not made here.
 *  - TodoWrite and TaskOutput are gone from 2.1.280 altogether; naming them
 *    restores nothing.
 *
 * Auto-approval is the right behaviour for the four that remain: they keep
 * the model's checklist and touch neither the filesystem nor the shell, and
 * prompting to approve "add a todo item" would be absurd.
 */
const TASK_LIST_TOOLS = ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'] as const;

/**
 * Represents a persistent SDK session for a specific conversation.
 *
 * Unlike the old single-turn QueryInstance, this keeps the SDK process alive
 * between user messages via an AsyncChannel that feeds the prompt iterable.
 */
interface SessionInstance {
  conversationId: string;
  query: Query;
  abortController: AbortController;
  messageHandler: SDKMessageHandler;
  permissionManager: PermissionManager;
  workingDirectory: string;
  startedAt: number;
  originalEnv: Record<string, string | undefined>;
  /** Channel for pushing user messages to the SDK process */
  inputChannel: AsyncChannel<SDKUserMessage>;
  /** Promise for the background message processing loop */
  messageLoopPromise: Promise<void>;
  /** SDK session ID (captured from init message) */
  sdkSessionId: string | null;
  /** Resolves when the session is initialized (session_id received) */
  sessionReady: Promise<void>;
  /** Resolver for sessionReady */
  resolveSessionReady: (() => void) | null;
  /** Model that was used to start this session */
  sessionModel: string;
  /** Whether this session was started with --resume (for error recovery) */
  isResumeAttempt: boolean;
  /**
   * `uuid` of the user message whose turn we are waiting on, or null between
   * turns.
   *
   * The CLI echoes this on the `result` that ends that turn, which is what
   * lets a turn be identified exactly instead of inferred from `origin` — see
   * resultEndsOurTurn.
   */
  pendingTurnUuid: string | null;
  /**
   * Whether the turn running now is one the CLI started on its own — its
   * answer to a background task finishing — rather than one the user sent.
   * Such a turn is ended by its own result, which carries no uuid of ours.
   * See beginUnpromptedTurn.
   */
  unpromptedTurn: boolean;
  /**
   * Messages sent while a turn was running that Claude has not read yet, by
   * uuid. See sendDuringTurn.
   */
  deliveringPrompts: Set<string>;
  /** The model the user selected when this session was started ('' = CLI default). */
  requestedModel: string;
  /**
   * `${source}:${modelAlias}` pairs already announced to the user, so a model
   * that differs from the selection is reported once per session instead of
   * once per assistant frame.
   */
  announcedModels: Set<string>;
  /**
   * The login this session's subprocess was spawned with.
   *
   * Credentials reach the CLI as environment variables, and a process's
   * environment cannot be changed from outside — so a session started before
   * the user logged in keeps using the account it was started with, for as
   * long as it lives. Sessions are deliberately long-lived, so "as long as it
   * lives" was the rest of the app's run. Compared against
   * `authGeneration` when a session is about to be reused; a mismatch means
   * the session is replaced rather than reused.
   */
  authGeneration: number;
}

export class ClaudeCodeService {
  private authValidator: AuthValidator;
  private errorHandler: ErrorHandler;

  // Channel mode service (lazily initialized)
  private channelService: ChannelService | null = null;

  // Multi-instance support: Map of conversation ID to active session
  private activeSessions: Map<string, SessionInstance> = new Map();
  // Conversations currently processing a query (subset of activeSessions keys)
  private processingSessions: Set<string> = new Set();
  /**
   * The SDK's latest live-task set per conversation.
   *
   * Already arrives with REPLACE semantics and is already forwarded to the
   * renderer; kept here as well so the main process can answer "is anything
   * still running" on its own. Asking the renderer at shutdown would mean a
   * round-trip while it is being torn down, and the renderer's own map is
   * reconstructed from notifications rather than being the authority.
   */
  private liveBackgroundTasks: Map<string, LiveBackgroundTask[]> = new Map();
  /**
   * Which login the credentials currently in config belong to.
   *
   * Bumped by `invalidateSessionAuth` whenever the user logs in or out. A
   * session records the value it was spawned with, and one holding an older
   * value is not reused. See `SessionInstance.authGeneration`.
   */
  private authGeneration: number = 0;
  private maxConcurrentQueries: number = MAX_CONCURRENT_QUERIES;

  // Bound sender function for DRY IPC communication
  private send: (channel: string, ...args: unknown[]) => boolean;
  // Cached models list (shared across all sessions)
  private cachedModels: ModelInfo[] = [];
  /**
   * The logged-in account, and the login it was read under. Keyed by
   * `authGeneration` so an account read before a login or logout is never
   * shown after it.
   */
  private cachedAccount: { generation: number; account: ClaudeAccount } | null = null;
  /** A read already under way, shared by everyone asking for the same login. */
  private accountRequest: { generation: number; promise: Promise<ClaudeAccount | null> } | null = null;
  // Cached slash commands (shared across all sessions)
  private cachedSlashCommands: SlashCommandInfo[] = [];
  // Cached subagent list (shared across all sessions)
  private cachedAgents: AgentInfo[] = [];
  /**
   * Conversations whose next session must resume at an earlier user message,
   * set by a conversation-scope rewind and consumed when that session starts.
   */
  private pendingRewindPoints = new Map<string, string>();
  private configService: ConfigService;
  private notificationService: NotificationService;
  private sessionPermissionCache: SessionPermissionCache;
  /**
   * Where image bytes from tool results are kept; messages carry references.
   *
   * Built on first use, not in a field initializer. The store resolves the
   * conversations directory, which asks Electron for the userData path — so
   * constructing it eagerly made merely CONSTRUCTING this service depend on
   * the Electron app being there. A service that cannot be built without the
   * app path cannot be built in a test, and 92 of them stopped at `new
   * ClaudeCodeService`.
   */
  private imageStoreInstance: ImageStore | null = null;
  private get imageStore(): ImageStore {
    this.imageStoreInstance ??= new ImageStore();
    return this.imageStoreInstance;
  }

  constructor(configService: ConfigService, getMainWindow: () => BrowserWindow | null, notificationService: NotificationService) {
    // Create bound sender using the provided window getter
    this.send = createSender(getMainWindow);

    this.configService = configService;
    this.notificationService = notificationService;

    // Initialize session permission cache (persists across queries per conversation)
    this.sessionPermissionCache = new SessionPermissionCache();
    this.sessionPermissionCache.onPermissionsChanged((conversationId, permissions) => {
      this.send(IPC_CHANNELS.CLAUDE_SESSION_PERMISSIONS_CHANGED, conversationId, permissions);
    });

    // Initialize shared modules (not per-session)
    this.authValidator = new AuthValidator(configService);
    this.errorHandler = new ErrorHandler();

    logger.info('ClaudeCodeService initialized with persistent session support', {
      maxConcurrentQueries: this.maxConcurrentQueries,
    });
  }

  /**
   * Handle action response from renderer (approve/reject)
   * Routes to the correct conversation's permission manager
   */
  handleActionResponse(conversationId: string, response: ActionResponse): void {
    // Channel mode: delegate permission verdicts to ChannelService
    if (this.channelService && this.channelService.isConversationActive(conversationId)) {
      this.channelService.handlePermissionResponse(
        conversationId,
        response.actionId,
        response.approved ? 'allow' : 'deny',
      );
      return;
    }

    const instance = this.activeSessions.get(conversationId);
    if (instance) {
      instance.permissionManager.handleActionResponse(response);
    } else {
      logger.warn('Cannot handle action response - no active session for conversation', {
        conversationId,
        actionId: response.actionId,
      });
    }
  }

  /**
   * Get the count of active sessions
   */
  getActiveQueryCount(): number {
    return this.activeSessions.size;
  }

  /**
   * Get the count of conversations currently processing a query
   */
  getProcessingQueryCount(): number {
    return this.processingSessions.size;
  }

  /**
   * Work that would be abandoned by quitting now.
   *
   * `turns` counts conversations mid-turn; `tasks` counts live background
   * tasks, excluding ambient ones — watchers and the like, which the SDK asks
   * hosts to keep out of activity indicators and which nobody would consider
   * work in progress.
   */
  getRunningWork(): { turns: number; tasks: number } {
    let tasks = 0;
    for (const conversationId of this.liveBackgroundTasks.keys()) {
      tasks += this.runningTasks(conversationId).length;
    }
    return { turns: this.processingSessions.size, tasks };
  }

  /**
   * A conversation's background tasks that count as work in progress: live,
   * and not ambient.
   */
  private runningTasks(conversationId: string): LiveBackgroundTask[] {
    // A session that has gone cannot still be running tasks; a stale set
    // left behind by one would otherwise count work that is not there.
    if (!this.activeSessions.has(conversationId)) return [];
    return (this.liveBackgroundTasks.get(conversationId) ?? []).filter((task) => !task.ambient);
  }

  /**
   * Check if a specific conversation has an active session
   */
  isConversationActive(conversationId: string): boolean {
    return this.activeSessions.has(conversationId);
  }

  /**
   * Get list of active conversation IDs
   */
  getActiveConversationIds(): string[] {
    return Array.from(this.activeSessions.keys());
  }

  /**
   * Get maximum concurrent queries limit
   */
  getMaxConcurrentQueries(): number {
    return this.maxConcurrentQueries;
  }

  /**
   * Get session permissions for a conversation
   */
  getSessionPermissions(conversationId: string): SessionPermissionEntry[] {
    return this.sessionPermissionCache.getPermissions(conversationId);
  }

  /**
   * Revoke a session permission
   */
  revokeSessionPermission(conversationId: string, permissionId: string): boolean {
    return this.sessionPermissionCache.revokePermission(conversationId, permissionId);
  }

  /**
   * Clear all session permissions for a conversation
   */
  clearSessionPermissions(conversationId: string): void {
    this.sessionPermissionCache.clearConversation(conversationId);
  }

  /**
   * Seed the cache for a conversation from persisted state (called by the
   * renderer after loading a saved conversation from disk). No-op if the
   * cache already has entries for this conversation.
   */
  seedSessionPermissions(conversationId: string, entries: SessionPermissionEntry[]): void {
    this.sessionPermissionCache.seed(conversationId, entries);
  }

  /**
   * Emit active query count to renderer
   */
  /**
   * Tell the renderer which conversations are running, not just how many.
   *
   * `processingSessions` is the only authority on whether a conversation is
   * mid-turn, and every change to it emits this. The renderer previously got
   * three numbers and had to maintain its own per-conversation busy flag,
   * which it set on send and cleared on CLAUDE_DONE — so a done that was
   * missed, duplicated or attributed to another turn left a conversation's
   * activity indicator wrong for the rest of the session, with nothing able to
   * correct it. Sending the set makes the renderer's view reconcilable, which
   * matters most with two conversations in flight.
   */
  private emitActiveQueryCount(): void {
    this.send(
      IPC_CHANNELS.CLAUDE_ACTIVE_QUERIES,
      this.activeSessions.size,
      this.maxConcurrentQueries,
      this.processingSessions.size,
      Array.from(this.processingSessions),
    );
  }

  /**
   * Send a message to Claude using the Claude Code SDK.
   *
   * If a persistent session already exists for this conversation,
   * the message is pushed to the existing channel (multi-turn).
   * Otherwise, a new persistent session is created.
   *
   * @param conversationId - The conversation this message belongs to
   * @param message - The message content
   * @param workingDirectory - The working directory for file operations
   * @param resumeSessionId - Optional SDK session ID to resume conversation context
   */
  async sendMessage(conversationId: string, message: string, workingDirectory: string, resumeSessionId?: string, images?: MessageImage[]): Promise<void> {
    // Channel mode: delegate to ChannelService (only valid with OAuth auth)
    const currentConfig = await this.configService.getConfig();
    if (currentConfig.executionMode === 'channel' && currentConfig.authMethod === 'oauth') {
      if (!this.channelService) {
        this.channelService = new ChannelService(
          this.configService,
          this.send,
          this.notificationService,
          (model) => this.resolveEffortForModel(model),
        );
        this.channelService.setOnTurnDone((convId) => {
          this.processingSessions.delete(convId);
          this.emitActiveQueryCount();
        });
      }
      this.processingSessions.add(conversationId);
      this.emitActiveQueryCount();
      await this.channelService.sendMessage(conversationId, message, workingDirectory, resumeSessionId);
      return;
    }

    // Resource limit caps *concurrently running* turns, not open sessions.
    // Idle persistent sessions don't block new work — otherwise the counter
    // would leak forever since sessions only close on subprocess exit / hard
    // shutdown (cleanupSession is not called on turn completion by design).
    if (this.processingSessions.size >= this.maxConcurrentQueries && !this.processingSessions.has(conversationId)) {
      const errorMsg = `Maximum concurrent runs (${this.maxConcurrentQueries}) reached. ` +
        `Please wait for another conversation's current turn to finish or cancel it.`;
      logger.warn('Resource limit reached', {
        processingCount: this.processingSessions.size,
        activeSessions: this.activeSessions.size,
        maxCount: this.maxConcurrentQueries,
        conversationId,
      });
      this.emitError(conversationId, errorMsg);
      return;
    }

    // Commands the GUI answers itself are intercepted in the renderer, before
    // the message is ever sent — see useSlashCommands there. They need the
    // renderer's own state (usage totals, context occupation, panels, the
    // CLAUDE.md viewer), so answering them here meant replying "not available
    // in GUI mode" to questions the GUI could in fact answer. Anything that
    // reaches this point is meant for the CLI.

    // Check if this is a slash command (starts with /)
    const isSlashCommand = message.trim().startsWith('/');

    // Mark this conversation as actively processing
    this.processingSessions.add(conversationId);
    this.emitActiveQueryCount();

    // Check if auth is configured
    if (!(await this.authValidator.hasAuth())) {
      this.processingSessions.delete(conversationId);
      this.emitActiveQueryCount();
      this.emitError(conversationId, 'Not authenticated. Please login with your Claude account or add an API key in Settings.');
      return;
    }

    // Get selected model to apply to the session
    const selectedModel = await this.configService.getSelectedModel();

    // Check for existing persistent session
    const existingSession = this.activeSessions.get(conversationId);

    // A session spawned under a different login cannot be reused: its
    // credentials are environment variables of a process that is already
    // running. Replacing it is not a loss — the conversation resumes by its
    // SDK session id, the same way it does after the app restarts — and it is
    // the only way a conversation that was already open follows the user to
    // the account they just logged into.
    if (existingSession && existingSession.authGeneration !== this.authGeneration) {
      logger.info('Replacing session started under a previous login', {
        conversationId,
        sessionGeneration: existingSession.authGeneration,
        currentGeneration: this.authGeneration,
        willResumeSdkSession: existingSession.sdkSessionId ?? '(none yet)',
      });
      const resumeFrom = resumeSessionId ?? existingSession.sdkSessionId ?? undefined;
      this.cleanupSession(conversationId);
      await this.startNewSession(
        conversationId, message, workingDirectory, isSlashCommand, resumeFrom, images,
      );
      return;
    }

    if (existingSession && !existingSession.inputChannel.isClosed()) {
      // If the model changed, use SDK's setModel() to switch mid-session
      // (no need to kill the session — context is preserved)
      if (selectedModel && existingSession.sessionModel !== selectedModel) {
        // Capture before the assignment below, otherwise the log reports the
        // new model as both the old and the new value.
        const previousModel = existingSession.sessionModel || '(default)';
        try {
          await existingSession.query.setModel(selectedModel);
          existingSession.sessionModel = selectedModel;
          existingSession.requestedModel = selectedModel;
          // Let the reconciler speak again if the new model doesn't stick.
          existingSession.announcedModels.clear();
          logger.info('Model changed on existing session via setModel()', {
            conversationId,
            oldModel: previousModel,
            newModel: selectedModel,
          });
        } catch (error) {
          logger.warn('Failed to setModel on existing session, will start new session', {
            conversationId, error,
          });
          this.cleanupSession(conversationId);
          await this.startNewSession(conversationId, message, workingDirectory, isSlashCommand, resumeSessionId, images);
          return;
        }
      }
      // Reuse existing session — push message to channel
      await this.sendToExistingSession(existingSession, message, isSlashCommand, images);
      return;
    }

    // If there's a dead session, clean it up first
    if (existingSession) {
      logger.info('Cleaning up dead session before starting new one', { conversationId });
      this.cleanupSession(conversationId);
    }

    // Create new persistent session
    await this.startNewSession(conversationId, message, workingDirectory, isSlashCommand, resumeSessionId, images);
  }

  /**
   * Send a message to an existing persistent session.
   */
  /**
   * The content of a user message: the text alone, or blocks when the user
   * attached images.
   *
   * `MessageParam.content` takes "a string or an array of content blocks
   * (text, image, document, tool_result, ...)" (sdk.d.ts) — and images have
   * to go here specifically: the SDK is explicit that blocks other than text
   * in `pastedContents` are ignored, so an image sent that way would vanish
   * without a word.
   *
   * The renderer sends references, not bytes: the bytes were stored when the
   * user attached them, so they cross IPC once instead of on every send, and
   * the message that gets persisted stays small. They are read back here,
   * where they are needed.
   *
   * Images go before the text, which is the order the composer shows them in.
   * An image whose bytes have gone missing is skipped rather than failing the
   * turn — the user's question is still worth asking.
   */
  private async userContent(
    conversationId: string,
    text: string,
    images?: MessageImage[],
  ): Promise<SDKUserMessage['message']['content']> {
    if (!images || images.length === 0) return text;

    const blocks: Array<
      { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }
      | { type: 'text'; text: string }
    > = [];

    for (const image of images) {
      try {
        const bytes = await this.imageStore.read(conversationId, image.id, image.mediaType);
        if (!bytes) {
          logger.warn('Skipped an attached image with no stored bytes', {
            conversationId, imageId: image.id,
          });
          continue;
        }
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: bytes.mediaType, data: bytes.base64 },
        });
      } catch (err) {
        logger.error('Failed to read an attached image', { conversationId, imageId: image.id, err });
      }
    }

    if (blocks.length === 0) return text;
    if (text.length > 0) blocks.push({ type: 'text', text });

    logger.info('Sending a user message with images', {
      conversationId, images: blocks.length - (text.length > 0 ? 1 : 0), textLength: text.length,
    });
    return blocks;
  }

  private async sendToExistingSession(session: SessionInstance, message: string, isSlashCommand: boolean, images?: MessageImage[]): Promise<void> {
    const { conversationId, messageHandler } = session;

    logger.info('Sending message to existing persistent session', {
      conversationId,
      messageLength: message.length,
      isSlashCommand,
      sdkSessionId: session.sdkSessionId?.slice(0, 20),
    });

    // Reset handler state for new turn
    messageHandler.reset();
    if (isSlashCommand) {
      messageHandler.markSlashCommandSent();
    }

    // Wait for session to be ready (session_id available)
    await session.sessionReady;

    if (!session.sdkSessionId) {
      logger.error('Session ready but no session_id available', { conversationId });
      this.emitError(conversationId, 'Session initialization failed. Please try again.');
      return;
    }

    await this.pushUserMessage(session, message, images);
    logger.info('Pushed user message to persistent session channel', { conversationId });
  }

  /**
   * Push a user message into a ready session, and return its uuid.
   *
   * The uuid is the join key the CLI echoes back on the result of the turn
   * that answers it — so it becomes the turn the conversation is busy for —
   * and on the message's lifecycle.
   */
  private async pushUserMessage(session: SessionInstance, message: string, images?: MessageImage[]): Promise<string> {
    const uuid = randomUUID();
    session.pendingTurnUuid = uuid;
    // Only awaited when there is something to read: with no attachments the
    // content IS the text, and going through an async call anyway would push
    // the message a microtask later than it used to go — a turn's start
    // delayed for the overwhelmingly common case that has no images at all.
    const userContent = images && images.length > 0
      ? await this.userContent(session.conversationId, message, images)
      : message;
    const userMessage: SDKUserMessage = {
      uuid,
      type: 'user',
      message: { role: 'user', content: userContent },
      parent_tool_use_id: null,
      session_id: session.sdkSessionId!,
      origin: HUMAN_ORIGIN,
    };
    session.inputChannel.push(userMessage);
    return uuid;
  }

  /**
   * Send a message into the turn running now, rather than after it.
   *
   * The CLI takes it at the turn's next step — between two tool calls — and
   * answers it within the same turn: measured on 2.1.280, a message sent
   * during a command was 'queued' at once, 'started' when the command
   * returned, and the turn's one result listed both messages. That is
   * reported back as 'started' (see trackDelivery), which is when the
   * renderer puts the message in the discussion.
   *
   * Only into a live session with a turn in flight, and nothing else: the
   * regular send may replace the session (another login), switch its model
   * or start a new one, and any of that would end the turn this message is
   * meant to join. Null when there is no such turn, for the caller to fall
   * back on sending it after.
   *
   * Nor is the handler reset, as it is for a new turn: its state is the
   * running turn's — what text was already streamed, whether a usage limit
   * refused it — and resetting it would garble or lose that.
   */
  async sendDuringTurn(conversationId: string, message: string, images?: MessageImage[]): Promise<string | null> {
    const session = this.activeSessions.get(conversationId);
    if (
      !session
      || session.inputChannel.isClosed()
      || !session.sdkSessionId
      || !this.processingSessions.has(conversationId)
    ) {
      logger.info('No turn to send into; the caller sends it after', { conversationId, hasSession: !!session });
      return null;
    }
    const uuid = await this.pushUserMessage(session, message, images);
    session.deliveringPrompts.add(uuid);
    logger.info('Sent a message into the running turn', { conversationId, uuid, messageLength: message.length });
    return uuid;
  }

  /**
   * Pass on what became of a message sent during a turn: 'started' once
   * Claude has it — or 'completed', should that come without a 'started' —
   * and 'cancelled' when it never will.
   */
  private trackDelivery(conversationId: string, uuid: string, state: string): void {
    const session = this.activeSessions.get(conversationId);
    if (!session?.deliveringPrompts.has(uuid)) return;
    const delivery: PromptDeliveryState | null =
      state === 'started' || state === 'completed' ? 'started'
        : state === 'cancelled' ? 'cancelled'
          : null;
    if (!delivery) return;
    session.deliveringPrompts.delete(uuid);
    logger.info('Message sent during a turn', { conversationId, uuid, delivery });
    this.send(IPC_CHANNELS.CLAUDE_PROMPT_DELIVERY, conversationId, uuid, delivery);
  }

  /**
   * Start a new persistent session for a conversation.
   *
   * Creates an AsyncChannel, starts query() with the channel as the prompt iterable,
   * launches a background message processing loop, and pushes the first user message.
   */
  private async startNewSession(
    conversationId: string,
    message: string,
    workingDirectory: string,
    isSlashCommand: boolean,
    resumeSessionId?: string,
    images?: MessageImage[],
  ): Promise<void> {
    // Create abort controller for this session
    const abortController = new AbortController();

    // Create per-conversation permission manager
    const permissionManager = new PermissionManager(
      this.configService,
      (action: PendingAction) => this.emitToolUse(conversationId, action),
      this.sessionPermissionCache,
      conversationId,
      (actionId: string) => this.emitToolExecuted(conversationId, actionId),
      (text: string) => this.pushAskUserQuestionFollowUp(conversationId, text),
    );

    // Create session ready promise (resolves when we get session_id from init)
    let resolveSessionReady: (() => void) | null = null;
    const sessionReady = new Promise<void>((resolve) => {
      resolveSessionReady = resolve;
    });

    // Create per-conversation message handler
    const messageHandler = new SDKMessageHandler({
      onChunk: (chunk: string) => {
        this.emitChunk(conversationId, chunk);
      },
      onSlashCommands: (commands: SlashCommandInfo[]) => {
        this.cachedSlashCommands = commands;
        this.emitSlashCommands(conversationId, commands);
      },
      onUserTurnUuid: (uuid: string) => {
        this.send(IPC_CHANNELS.CLAUDE_USER_TURN_UUID, conversationId, uuid);
      },
      onTaskNotification: (notification: TaskNotification) => {
        this.emitTaskNotification(conversationId, notification);
      },
      onLiveBackgroundTasks: (tasks: LiveBackgroundTask[]) => {
        // The set is authoritative, so a task gone from it has ended —
        // however its own notification fared.
        const stillLive = new Set(tasks.map((task) => task.taskId));
        for (const ended of this.runningTasks(conversationId).filter((task) => !stillLive.has(task.taskId))) {
          void this.notificationService.showTaskEnded(conversationId, ended.description);
        }
        this.liveBackgroundTasks.set(conversationId, tasks);
        this.send(IPC_CHANNELS.CLAUDE_BACKGROUND_TASKS_CHANGED, conversationId, tasks);
      },
      onUsageUpdate: async (usage: SessionUsage) => {
        try {
          const session = this.activeSessions.get(conversationId);
          const ctx = await session?.query.getContextUsage();
          if (ctx) {
            usage.contextTokens = ctx.totalTokens;
            usage.contextMaxTokens = ctx.maxTokens;
          }
        } catch {
          // getContextUsage may not be available on all SDK versions
        }
        this.emitUsageUpdate(conversationId, usage);
      },
      onSystemNote: (note: string) => {
        this.emitSystemNote(conversationId, note);
      },
      onToolUseCapture: (capture: ToolCaptureData) => {
        this.send(IPC_CHANNELS.CLAUDE_TOOL_CAPTURE, conversationId, capture);
      },
      onToolResult: (result: {
        toolUseBlockId: string;
        content: string;
        taskListId?: string;
        agent?: AgentRun;
        images?: ExtractedImage[];
      }) => {
        const outputFile = writeToolResultFile(conversationId, result.toolUseBlockId, result.content);
        // Forward small results inline so renderer features (task list panel)
        // don't need to read the file. Large results stay on disk only.
        const INLINE_CONTENT_MAX_BYTES = 4096;
        const contentBytes = Buffer.byteLength(result.content, 'utf-8');
        const inlineContent = contentBytes <= INLINE_CONTENT_MAX_BYTES
          ? result.content
          : undefined;
        logger.info('Tool result delivered', {
          toolUseBlockId: result.toolUseBlockId,
          contentBytes,
          inline: inlineContent !== undefined,
          taskListId: result.taskListId,
          contentPreview: result.content.slice(0, 200),
        });
        // Images are stored before the result is announced, so the renderer
        // never receives a reference to bytes that are not there yet. The
        // bytes themselves do not travel: a screenshot is megabytes, and the
        // renderer fetches them by id only when it draws them.
        const deliver = (images?: MessageImage[]): void => {
          this.send(IPC_CHANNELS.CLAUDE_TOOL_RESULT, conversationId, {
            toolUseBlockId: result.toolUseBlockId,
            outputFile,
            ...(inlineContent !== undefined && { content: inlineContent }),
            ...(result.taskListId && { taskListId: result.taskListId }),
            ...(result.agent && { agent: result.agent }),
            ...(images && images.length > 0 && { images }),
          });
        };

        if (!result.images || result.images.length === 0) {
          deliver();
          return;
        }

        void (async () => {
          const stored: MessageImage[] = [];
          for (const image of result.images ?? []) {
            try {
              const ref = await this.imageStore.save(conversationId, {
                base64: image.base64,
                mediaType: image.mediaType,
                origin: 'tool',
                ...(image.width ? { width: image.width } : {}),
                ...(image.height ? { height: image.height } : {}),
              });
              if (ref) stored.push(ref);
            } catch (err) {
              // An image that cannot be stored must not cost the result it
              // came with: the text is the part the model acted on.
              logger.error('Failed to store a tool image', {
                conversationId, toolUseBlockId: result.toolUseBlockId, err,
              });
            }
          }
          deliver(stored);
        })();
      },
      onModelReported: (model: string, source: ModelReportSource) => {
        this.reconcileReportedModel(conversationId, model, source);
      },
      onModelSubstituted: (event: ModelSubstitutionEvent) => {
        this.reportModelSubstitution(conversationId, event);
      },
      onSubagentActivity: (activity: SubagentActivity) => {
        this.send(IPC_CHANNELS.CLAUDE_SUBAGENT_ACTIVITY, conversationId, activity);
      },
      onSessionRunning: () => {
        this.beginUnpromptedTurn(conversationId);
      },
      onCommandLifecycle: (uuid: string, state: string) => {
        this.trackDelivery(conversationId, uuid, state);
      },
      onSessionIdle: () => {
        this.endStrandedTurn(conversationId, 'session reported idle');
      },
      onSessionId: (sessionId: string) => {
        // Capture session ID for constructing SDKUserMessage
        const session = this.activeSessions.get(conversationId);
        if (session) {
          session.sdkSessionId = sessionId;
          // Resolve the sessionReady promise so sendToExistingSession can proceed
          if (session.resolveSessionReady) {
            session.resolveSessionReady();
            session.resolveSessionReady = null;
          }
        }
        this.emitSessionId(conversationId, sessionId);
      },
      onUsageWarning: (warning) => {
        this.send(IPC_CHANNELS.CLAUDE_USAGE_WARNING, warning);
      },
      onAuthError: () => {
        const session = this.activeSessions.get(conversationId);
        if (session?.isResumeAttempt) {
          // During resume, a 401 likely means the stale session belongs to a
          // different auth context (e.g. after migration/re-login).  Clear the
          // session ID and let the user retry without destroying the fresh token.
          logger.warn('Auth error during resume attempt — treating as stale session, not token invalidation', { conversationId });
          this.emitClearSessionId(conversationId);
          this.emitError(conversationId,
            'Could not resume conversation context — authentication failed for the previous session. ' +
            'Your conversation history is preserved. Send your message again to continue with a fresh context.');
          return;
        }
        this.handleAuthInvalidated().catch(err =>
          logger.error('handleAuthInvalidated failed', { err })
        );
      },
    });

    if (isSlashCommand) {
      messageHandler.markSlashCommandSent();
      logger.debug('Detected slash command', { conversationId, command: message.trim().split(' ')[0] });
    }

    // Track original env values for cleanup
    const originalEnv: Record<string, string | undefined> = {};

    try {
      // Get selected model from config
      const selectedModel = await this.configService.getSelectedModel();
      const thinkingMode = await this.configService.getThinkingMode();
      const thinkingConfig: ThinkingConfig = thinkingMode === 'disabled'
        ? { type: 'disabled' }
        : { type: 'adaptive' };
      // Effort is clamped to what the selected model actually accepts. The CLI
      // would silently downgrade an unsupported level anyway, but clamping
      // here means the level we log is the level that ran, and a model that
      // takes no effort gets no effort parameter at all.
      const effort = await this.resolveEffortForModel(selectedModel);
      // When resuming we also call setModel() after init, because a resumed
      // session restores the model it was created with.
      const shouldResume = !!resumeSessionId;
      const managedSettings = await this.buildManagedSettings(selectedModel);

      logger.info('Starting new persistent session', {
        conversationId,
        messageLength: message.length,
        workingDirectory,
        isSlashCommand,
        model: selectedModel || '(SDK default)',
        thinkingMode,
        effort: effort ?? '(none — model takes no effort)',
        activeSessions: this.activeSessions.size,
        hasResumeSessionId: !!resumeSessionId,
        willResume: shouldResume,
        willSetModelAfterResume: shouldResume && !!selectedModel,
      });

      // Set up authentication environment, plus any model enforcement that
      // has to travel as an env var rather than a setting.
      //
      // CLAUDE_CODE_TMPDIR puts the CLI's task output files under a directory
      // this app knows, which is the only way to find a running command's
      // output: no message names its file until it has finished. See
      // cliTempRoot. The CLI refuses a temp root it cannot verify as a
      // directory, so it is created first.
      const tempRoot = cliTempRoot();
      fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
      const authEnv = {
        ...(await this.authValidator.setupAuthEnv()),
        ...(await this.buildModelEnforcementEnv(selectedModel)),
        CLAUDE_CODE_TMPDIR: tempRoot,
        // Has the CLI report each turn starting and ending
        // (session_state_changed). Without it nothing marks the start of a
        // turn the CLI begins by itself when a background task finishes, and
        // that turn ran with no activity indicator at all.
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      };

      // CRITICAL: Set auth env vars in actual process.env BEFORE calling query()
      Object.entries(authEnv).forEach(([key, value]) => {
        originalEnv[key] = process.env[key];
        process.env[key] = value;
      });

      // Create the async channel for multi-turn input
      const inputChannel = new AsyncChannel<SDKUserMessage>();

      // Minted before the session exists because both the session record and
      // the first pushed message need it: it is the key the CLI echoes on this
      // turn's result, which is how that result is known to be ours.
      const firstTurnUuid = randomUUID();

      // Set by a conversation-scope rewind: the session resumes at that user
      // message, so everything after it leaves the transcript. Consumed here so
      // it applies once, to the session the rewind asked for, rather than to
      // every later session of this conversation.
      const rewindPoint = this.pendingRewindPoints.get(conversationId);
      this.pendingRewindPoints.delete(conversationId);
      if (rewindPoint) {
        logger.info('Resuming session at an earlier user message', { conversationId, rewindPoint });
      }

      // Start query with AsyncIterable prompt — this keeps the process alive
      const queryIterator = query({
        prompt: inputChannel,
        options: {
          cwd: workingDirectory,
          abortController,
          env: authEnv,
          pathToClaudeCodeExecutable: ClaudeCliPaths.findBundledCli() || undefined,
          canUseTool: permissionManager.createCanUseToolCallback(),
          includePartialMessages: true,
          agentProgressSummaries: true,
          thinking: thinkingConfig,
          // Required for /rewind. The SDK documents it as what makes
          // Query.rewindFiles() work: "File checkpointing creates backups of
          // files before they are modified, allowing you to restore them to
          // previous states." Without it rewindFiles has nothing to restore
          // from and refuses, which is why /rewind did nothing at all.
          enableFileCheckpointing: true,
          // Restores the task-list tools the CLI dropped; see TASK_LIST_TOOLS.
          allowedTools: [...TASK_LIST_TOOLS],
          // Stop means "stop this turn", not "kill everything running".
          //
          // The SDK documents this as the switch: "When declared, an interrupt
          // on an open-input (interactive stream-json) session spares running
          // background agents/workflows — Stop only aborts the current turn,
          // and tasks are stopped one at a time through the consumer's own
          // affordance." And it "fails closed on absence: without the
          // declaration, an interrupt kills background tasks, because a spared
          // runaway task would otherwise be unstoppable from this consumer
          // short of ending the session."
          //
          // That fail-closed default is what made Stop take the agents and
          // background tasks down with the turn. Declaring it is a promise we
          // actually keep: the background-task detail modal has a per-task
          // stop wired to `stopTask` below, and the Stop button offers
          // "stop everything" for killing the lot deliberately.
          //
          // Only valid on this lane — `prompt` here is an async input channel,
          // so the session is open-input. The CLI takes the declaration from
          // the first client to attach, so it belongs at session start.
          perTaskStopAffordance: true,
          ...(effort ? { effort } : {}),
          // Always pass the selection, including on resume. `--model` is
          // documented as "Model for the current session" with no resume
          // carve-out; if a given CLI build does ignore it while resuming, the
          // setModel() call below and the init-message reconciliation still
          // converge the session onto the selected model and tell the user.
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(managedSettings ? { managedSettings } : {}),
          ...(shouldResume ? { resume: resumeSessionId } : {}),
          ...(rewindPoint ? { resumeSessionAt: rewindPoint } : {}),
          spawnClaudeCodeProcess: (options: SpawnOptions): SpawnedProcess => {
            return this.spawnSDKProcess(options, conversationId);
          },
        },
      });

      // Create and store the session instance
      const session: SessionInstance = {
        conversationId,
        query: queryIterator,
        abortController,
        messageHandler,
        permissionManager,
        workingDirectory,
        startedAt: Date.now(),
        originalEnv,
        inputChannel,
        messageLoopPromise: Promise.resolve(), // Will be set below
        sdkSessionId: null,
        sessionReady,
        resolveSessionReady,
        sessionModel: shouldResume ? '' : selectedModel,
        isResumeAttempt: shouldResume,
        pendingTurnUuid: firstTurnUuid,
        unpromptedTurn: false,
        deliveringPrompts: new Set<string>(),
        requestedModel: selectedModel,
        announcedModels: new Set<string>(),
        // Recorded now, because `authEnv` above was read now. See
        // invalidateSessionAuth.
        authGeneration: this.authGeneration,
      };
      this.activeSessions.set(conversationId, session);
      this.emitActiveQueryCount();

      // If resuming with an explicit model preference, apply it after session initializes.
      // The first turn uses the resumed session's model; subsequent turns use the selected model.
      if (shouldResume && selectedModel) {
        sessionReady.then(async () => {
          try {
            await queryIterator.setModel(selectedModel);
            session.sessionModel = selectedModel;
            logger.info('Applied model preference after session resume', {
              conversationId,
              model: selectedModel,
            });
          } catch (err) {
            logger.warn('Failed to set model after session resume', {
              conversationId,
              model: selectedModel,
              error: err instanceof Error ? err.message : String(err),
            });
            // Silently continuing here is what lets a resumed conversation keep
            // running on the model it was created with. Say so.
            this.emitSystemNote(
              conversationId,
              `Could not apply your model selection (${formatModelId(selectedModel)}) to this ` +
              'resumed conversation. It is still running the model it was started with.',
            );
          }
        });
      }

      // Start background message processing loop
      session.messageLoopPromise = this.processMessageLoop(conversationId, queryIterator, messageHandler);

      // Fetch full slash command details and available models
      this.fetchAndEmitSlashCommandDetails(conversationId, queryIterator);
      this.fetchAndCacheModels(queryIterator);

      // Push the first user message IMMEDIATELY — do NOT wait for session_id.
      // With AsyncIterable prompt, the SDK only sends the init message (containing
      // session_id) AFTER consuming the first user message from the channel.
      // Waiting for session_id before pushing would deadlock.
      // For the first message, use resumeSessionId if available, or empty string.
      // The SDK assigns/validates the session_id server-side regardless.
      // See sendToExistingSession: awaited only when there are attachments.
      const userContent = images && images.length > 0
        ? await this.userContent(conversationId, message, images)
        : message;
      const userMessage: SDKUserMessage = {
        uuid: firstTurnUuid,
        type: 'user',
        message: { role: 'user', content: userContent },
        parent_tool_use_id: null,
        session_id: resumeSessionId || '',
        origin: HUMAN_ORIGIN,
      };

      inputChannel.push(userMessage);
      logger.info('Pushed first user message to new persistent session', {
        conversationId,
        resumeSessionId: resumeSessionId?.slice(0, 20),
      });
    } catch (error) {
      this.handleQueryError(conversationId, error as Error, messageHandler);
      this.cleanupSession(conversationId);
    }
  }

  /**
   * Background message processing loop for a persistent session.
   *
   * Runs `for await` over the query's async generator. This runs as a detached
   * promise. Task notifications (task_started, task_progress, task_updated,
   * task_notification) flow natively through the stream between turns.
   *
   * `emitDone` is called after each `result` message (turn completion),
   * not at the end of the loop (which only happens when the session ends).
   */
  private async processMessageLoop(
    conversationId: string,
    queryIterator: Query,
    messageHandler: SDKMessageHandler,
  ): Promise<void> {
    try {
      for await (const sdkMessage of queryIterator) {
        // Check if session was cleaned up while processing
        if (!this.activeSessions.has(conversationId)) {
          logger.debug('Session was cleaned up, stopping message loop', { conversationId });
          break;
        }

        const session = this.activeSessions.get(conversationId);

        await messageHandler.handleMessage(sdkMessage);

        // After each result message, emit done to signal turn completion.
        // Only for turns the user actually started — a background agent's
        // completion is delivered as its own `result` and must not end the
        // main turn (see resultEndsOurTurn).
        if (sdkMessage.type === 'result') {
          const resultSubtype = (sdkMessage as { subtype?: string }).subtype;
          const endsUserTurn = resultEndsOurTurn(
            sdkMessage as {
              origin?: { kind?: string };
              user_message_uuid?: string;
              user_message_uuids?: string[];
            },
            session?.pendingTurnUuid ?? null,
          );

          // Detect resume failure from result message (before the thrown error path)
          if (endsUserTurn && session?.isResumeAttempt && resultSubtype?.startsWith('error')) {
            const resultError = resolveResultError(
              sdkMessage as { error?: string; errors?: string[] },
            );
            if (this.isResumeSessionError(resultError)) {
              logger.warn('Resume session failed (result message) — clearing stale session ID', {
                conversationId,
                error: resultError,
              });
              this.emitClearSessionId(conversationId);
              this.emitError(conversationId,
                'Could not resume conversation context — the session has expired or was cleaned up. ' +
                'Your conversation history is preserved, but Claude will not remember previous messages. ' +
                'Send your message again to continue with a fresh context.');
              break;
            }
          }

          // Resume succeeded — subsequent auth errors are real, not stale-session artifacts
          if (endsUserTurn && session?.isResumeAttempt) {
            session.isResumeAttempt = false;
          }

          // Any other error result subtype must reach the user. Without this, an
          // error_during_execution result that doesn't match the resume-failure
          // pattern would silently emit DONE and leave the user with no
          // explanation of why nothing came back from Claude.
          if (resultSubtype && resultSubtype !== 'success') {
            const resultError = resolveResultError(
              sdkMessage as { error?: string; errors?: string[] },
            );
            const friendly = this.errorHandler.getHumanReadableError(
              resultError || `SDK ended the turn with ${resultSubtype}.`,
            );
            logger.warn('Surfacing non-success result to user', {
              conversationId,
              subtype: resultSubtype,
              error: resultError,
            });
            this.emitError(conversationId, friendly);
          }

          // Turn-lifecycle diagnostics. The spinner is cleared only by
          // CLAUDE_DONE, so when it sticks the question is always "was a
          // result seen, what origin did it carry, and what did we decide".
          // One line answers all three.
          // A turn the CLI started by itself ends on its own result — unless
          // the user has sent something since, whose turn the conversation
          // stays busy for.
          const endsUnpromptedTurn = !endsUserTurn && !!session?.unpromptedTurn && !session.pendingTurnUuid;
          logger.info('[turn] result', {
            conversationId,
            subtype: resultSubtype,
            origin: (sdkMessage as { origin?: { kind?: string } }).origin?.kind ?? '(absent)',
            endsUserTurn,
            unpromptedTurn: session?.unpromptedTurn ?? false,
            stillProcessing: this.processingSessions.has(conversationId),
            decision: endsUserTurn
              ? 'emit done'
              : endsUnpromptedTurn ? 'end unprompted turn' : 'ignore (background)',
          });

          if (session && !endsUserTurn && session.unpromptedTurn) {
            session.unpromptedTurn = false;
            if (endsUnpromptedTurn) this.emitDone(conversationId, true);
            continue;
          }

          if (!endsUserTurn) {
            // Background-agent activity completing. The main conversation may
            // still be mid-turn: leave the spinner, the processing count and
            // the "Query Complete" notification alone. Progress for these is
            // already surfaced through task notifications.
            continue;
          }

          // The turn this uuid identified is over. Cleared so a later result
          // cannot match it, which would end a turn that has not started.
          if (session) {
            session.pendingTurnUuid = null;
            session.unpromptedTurn = false;
          }

          // Sent before done, so the renderer knows the turn is waiting on a
          // usage limit by the time it decides what to do with the queue.
          const usageLimit = messageHandler.takeUsageLimitStop();
          if (usageLimit) {
            logger.info('Turn stopped by a usage limit', {
              conversationId,
              resetsAt: new Date(usageLimit.resetsAt).toISOString(),
              limitType: usageLimit.limitType,
            });
            this.send(IPC_CHANNELS.CLAUDE_USAGE_LIMIT, conversationId, usageLimit);
          }

          this.emitDone(conversationId);
        }
      }

      // Generator exhausted — session ended (process exited). Nothing further
      // can arrive, so a turn still marked busy here would spin forever.
      logger.info('Persistent session message loop ended', { conversationId });
      this.endStrandedTurn(conversationId, 'message stream ended');
    } catch (error) {
      this.handleQueryError(conversationId, error as Error, messageHandler);
    } finally {
      // Clean up the session when the loop ends
      // (only if still registered — abort may have already cleaned up)
      if (this.activeSessions.has(conversationId)) {
        this.cleanupSession(conversationId);
      }
    }
  }

  /**
   * Fetch full slash command details and emit to renderer.
   */
  /**
   * Map an SDK command row to the renderer's shape.
   *
   * `aliases` and `builtin` are carried across deliberately: without aliases
   * `/cost` does not resolve to `/usage` the way it does in the CLI, and
   * without `builtin` the autocomplete cannot tell Claude Code's own commands
   * from a project's, nor resolve a name both define.
   */
  private static toSlashCommandInfo(cmd: SlashCommand): SlashCommandInfo {
    return {
      name: cmd.name,
      description: cmd.description,
      argumentHint: cmd.argumentHint,
      ...(cmd.aliases && cmd.aliases.length > 0 ? { aliases: cmd.aliases } : {}),
      ...(cmd.builtin ? { builtin: true } : {}),
    };
  }

  private async fetchAndEmitSlashCommandDetails(conversationId: string, queryIterator: Query): Promise<void> {
    try {
      const commands = await queryIterator.supportedCommands();
      const slashCommands = commands.map((cmd) => ClaudeCodeService.toSlashCommandInfo(cmd));

      // Update cached commands
      this.cachedSlashCommands = slashCommands;

      // Emit to renderer
      this.emitSlashCommands(conversationId, slashCommands);
      logger.info('Emitted full slash command details', {
        conversationId,
        count: slashCommands.length,
      });
    } catch (error) {
      logger.warn('Failed to fetch and emit slash command details', { conversationId, error });
    }
  }

  /**
   * Spawn the SDK process with platform-specific handling
   */
  private spawnSDKProcess(options: SpawnOptions, conversationId: string): SpawnedProcess {
    let spawnFile: string = options.command;
    let spawnArgs: string[] = options.args;
    let extraEnv: Record<string, string> = {};

    // On Windows, configure bundled Git Bash and Node.js paths
    if (process.platform === 'win32') {
      const result = this.getWindowsSpawnConfig(options, spawnArgs);
      spawnFile = result.spawnFile;
      spawnArgs = result.spawnArgs;
      extraEnv = result.extraEnv;
    }

    logger.info('Spawning SDK process', {
      conversationId,
      command: spawnFile,
      args: spawnArgs.filter(a => !a.startsWith('ANTHROPIC_API_KEY') && !a.startsWith('CLAUDE_CODE_OAUTH')),
      cwd: options.cwd,
      hasOAuthToken: !!options.env?.CLAUDE_CODE_OAUTH_TOKEN,
      hasApiKey: !!options.env?.ANTHROPIC_API_KEY,
    });

    const childProcess: ChildProcess = spawn(spawnFile, spawnArgs, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
    });

    this.setupProcessLogging(childProcess, conversationId);

    return childProcess as SpawnedProcess;
  }

  /**
   * Get Windows-specific spawn configuration.
   * Adds bundled Git Bash paths to the environment (required by Claude Code CLI).
   * Uses the SDK-provided command (native binary) directly.
   */
  private getWindowsSpawnConfig(
    options: SpawnOptions,
    originalArgs: string[]
  ): { spawnFile: string; spawnArgs: string[]; extraEnv: Record<string, string> } {
    const extraEnv: Record<string, string> = {};

    if (WindowsPaths.hasBundledGitBash()) {
      const bundledGitBash = WindowsPaths.getBashExe();
      logger.info('Windows: using bundled Git Bash', { bundledGitBash });
      extraEnv.CLAUDE_CODE_GIT_BASH_PATH = bundledGitBash;
      extraEnv.PATH = WindowsPaths.buildEnhancedPath();
    } else {
      logger.warn('Windows: bundled Git Bash not found');
    }

    return {
      spawnFile: options.command,
      spawnArgs: originalArgs,
      extraEnv,
    };
  }

  /**
   * Set up logging for the spawned process
   */
  private setupProcessLogging(childProcess: ChildProcess, conversationId: string): void {
    let stderrData = '';
    if (childProcess.stderr) {
      childProcess.stderr.on('data', (data) => {
        stderrData += data.toString();
        logger.debug('SDK process stderr', { conversationId, data: data.toString().slice(0, 500) });
      });
    }

    childProcess.on('spawn', () => {
      logger.debug('SDK process spawned successfully', { conversationId, pid: childProcess.pid });
    });

    childProcess.on('error', (error) => {
      logger.error('SDK process spawn error', {
        conversationId,
        error: error.message,
        code: (error as NodeJS.ErrnoException).code,
      });
    });

    childProcess.on('exit', (code, signal) => {
      if (code !== 0 && code !== null && signal !== 'SIGTERM' && signal !== 'SIGINT') {
        logger.warn('SDK process exited unexpectedly', {
          conversationId,
          code,
          signal,
          pid: childProcess.pid,
          stderr: stderrData.slice(0, 1000),
        });

        // Safety net: if the process died without any result message reaching
        // the user (the message loop's catch handles thrown errors, but a
        // silent stderr exit could slip past every other path), surface what
        // we saw on stderr so the user is never left with a frozen UI.
        // Defer to the next tick so handleQueryError (if it fires from the
        // iterator throw) runs first and we don't double-emit.
        setImmediate(() => {
          if (!this.activeSessions.has(conversationId)) return;
          const trimmed = stderrData.trim();
          if (!trimmed) return;
          logger.warn('Surfacing SDK process stderr as fallback error', {
            conversationId,
            preview: trimmed.slice(0, 200),
          });
          this.emitError(
            conversationId,
            this.errorHandler.getHumanReadableError(trimmed),
          );
          this.emitDone(conversationId);
        });
      } else {
        logger.debug('SDK process exited', { conversationId, code, signal });
      }
    });
  }

  /**
   * Handle query errors.
   *
   * Every exit path here must leave the renderer in a clean state — emit
   * CLAUDE_ERROR (so the user sees what happened) and CLAUDE_DONE (so the
   * loading spinner clears and the input gate unlocks). The DONE is
   * belt-and-suspenders since onError also clears loading, but a missed
   * DONE here would compound badly with any future renderer change.
   */
  private handleQueryError(conversationId: string, error: Error, messageHandler: SDKMessageHandler): void {
    this.processingSessions.delete(conversationId);
    this.emitActiveQueryCount();

    if (this.errorHandler.isAbortError(error)) {
      logger.info('Request aborted', { conversationId });
      this.emitDone(conversationId);
      return;
    }

    const errorMessage = error.message || '';

    // Handle process exit errors that occur after successful query completion
    if (this.errorHandler.isPostSuccessProcessExitError(errorMessage, messageHandler.didQuerySucceed())) {
      logger.warn('Process exit error after successful query (ignoring)', {
        conversationId,
        error: errorMessage,
      });
      this.emitDone(conversationId);
      return;
    }

    // Handle resume session failures: clear the stale session ID so the next
    // attempt doesn't fail on the same expired ID, and show a specific error.
    const session = this.activeSessions.get(conversationId);
    const lowerError = errorMessage.toLowerCase();
    const isAuthError = lowerError.includes('401') || lowerError.includes('unauthorized') ||
        lowerError.includes('invalid bearer') || lowerError.includes('invalid token');

    if (session?.isResumeAttempt && (this.isResumeSessionError(errorMessage) || isAuthError)) {
      // During resume, auth errors likely mean the stale session belongs to a
      // different auth context (e.g. after migration/re-login).  Clear the
      // session ID and let the user retry without destroying the fresh token.
      logger.warn('Resume session failed — clearing stale session ID', {
        conversationId,
        error: errorMessage,
        wasAuthError: isAuthError,
      });
      this.emitClearSessionId(conversationId);
      this.emitError(conversationId,
        'Could not resume conversation context — the session has expired or was cleaned up. ' +
        'Your conversation history is preserved, but Claude will not remember previous messages. ' +
        'Send your message again to continue with a fresh context.');
      this.emitDone(conversationId);
      return;
    }

    logger.error('Failed to send message', { conversationId, error });

    // Detect 401/auth errors and auto-clear credentials
    if (isAuthError) {
      this.handleAuthInvalidated().catch(() => {});
      this.emitError(conversationId, 'Authentication failed. Please log in again in Settings.');
      this.emitDone(conversationId);
      return;
    }

    const userMessage = this.errorHandler.getHumanReadableError(errorMessage);
    this.emitError(conversationId, userMessage);
    this.emitDone(conversationId);
  }

  /**
   * Clean up a persistent session
   */
  /**
   * The login changed — stop any session from going on using the old one.
   *
   * Credentials are environment variables of the CLI subprocess, set when that
   * process is spawned, and nothing outside a process can change its
   * environment. So logging in did nothing at all to conversations that were
   * already open: they kept talking to the account they were started with, and
   * since sessions are deliberately long-lived, that lasted the rest of the
   * run. Logging out was the same, which is worse — a session kept a working
   * token after the user had signed out of it.
   *
   * Two cases, because a session with a turn in flight cannot simply be
   * killed:
   *
   *  - idle: ended here and now. Nothing is lost; the conversation resumes by
   *    its SDK session id on its next message, exactly as it does after a
   *    restart, and that new process gets the new credentials. Ending it also
   *    means no process is left holding a token the user has just signed out
   *    of.
   *  - busy: left alone, and marked by the generation bump. Its current turn
   *    finishes under the old login — unavoidable, the environment is already
   *    set — and the mismatch makes the next message replace it rather than
   *    reuse it. Killing it instead would abort whatever the user is running,
   *    including background agents, to deliver a credential change they can
   *    wait a turn for.
   *
   * @returns how many sessions were ended immediately, and how many were left
   *          to be replaced after their current turn.
   */
  invalidateSessionAuth(reason: 'login' | 'logout'): { ended: number; deferred: number } {
    this.authGeneration += 1;

    const idle: string[] = [];
    let deferred = 0;
    for (const conversationId of this.activeSessions.keys()) {
      if (this.processingSessions.has(conversationId)) {
        deferred += 1;
      } else {
        idle.push(conversationId);
      }
    }

    for (const conversationId of idle) {
      this.cleanupSession(conversationId);
    }

    logger.info('Auth changed — sessions invalidated', {
      reason,
      generation: this.authGeneration,
      ended: idle.length,
      deferredUntilTurnEnds: deferred,
    });

    return { ended: idle.length, deferred };
  }

  private cleanupSession(conversationId: string): void {
    const instance = this.activeSessions.get(conversationId);
    if (!instance) {
      return;
    }

    // Its live-task set goes with it: a session that is gone cannot be
    // running anything.
    this.liveBackgroundTasks.delete(conversationId);

    // Nor read anything still waiting for its next step: said, so the
    // renderer gives those messages back to the user instead of waiting on
    // them for ever.
    for (const uuid of instance.deliveringPrompts) {
      this.send(IPC_CHANNELS.CLAUDE_PROMPT_DELIVERY, conversationId, uuid, 'cancelled' satisfies PromptDeliveryState);
    }
    instance.deliveringPrompts.clear();

    // Close the input channel (stops the SDK from waiting for more input)
    instance.inputChannel.close();

    // Close the query (terminates the subprocess)
    try {
      instance.query.close();
    } catch {
      // Ignore errors from closing (process may already be dead)
    }

    // Clear pending permissions
    instance.permissionManager.clearPendingPermissions();

    // Restore original process.env values
    Object.entries(instance.originalEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });

    // Remove from active and processing sessions
    this.activeSessions.delete(conversationId);
    this.processingSessions.delete(conversationId);
    this.emitActiveQueryCount();

    logger.debug('Cleaned up persistent session', {
      conversationId,
      remainingSessions: this.activeSessions.size,
    });
  }

  /**
   * Approve a pending action (called from IPC handler)
   */
  async approveAction(
    conversationId: string,
    actionId: string,
    updatedInput?: Record<string, unknown>,
    alwaysAllow?: boolean,
    chosenScope?: import('../../shared/types').PermissionScope,
    chosenVariant?: import('../../shared/types').PermissionOptionVariant,
  ): Promise<void> {
    // Channel mode: route to channel service (PTY-based permission handling)
    if (this.channelService && this.channelService.isConversationActive(conversationId)) {
      this.channelService.handlePermissionResponse(conversationId, actionId, 'allow');
      this.emitToolExecuted(conversationId, actionId);
      return;
    }

    const instance = this.activeSessions.get(conversationId);
    if (instance) {
      instance.permissionManager.handleActionResponse({
        conversationId,
        actionId,
        approved: true,
        updatedInput,
        alwaysAllow,
        chosenScope,
        ...(chosenVariant ? { chosenVariant } : {}),
      });
      // Notify renderer that the tool is now executing (spinner → check)
      this.emitToolExecuted(conversationId, actionId);
    } else {
      logger.warn('Cannot approve action - no active session for conversation', { conversationId, actionId });
    }
  }

  /**
   * Reject a pending action (called from IPC handler)
   */
  async rejectAction(conversationId: string, actionId: string, message?: string): Promise<void> {
    // Channel mode: route to channel service (PTY-based permission handling)
    if (this.channelService && this.channelService.isConversationActive(conversationId)) {
      this.channelService.handlePermissionResponse(conversationId, actionId, 'deny');
      return;
    }

    const instance = this.activeSessions.get(conversationId);
    if (instance) {
      instance.permissionManager.handleActionResponse({
        conversationId,
        actionId,
        approved: false,
        denyMessage: message,
      });
    } else {
      logger.warn('Cannot reject action - no active session for conversation', { conversationId, actionId });
    }
  }

  /**
   * Deliver the user's answer to a pending AskUserQuestion (called from IPC handler).
   * Routes to the channel service in channel mode, or PermissionManager in SDK mode.
   */
  async handleQuestionAnswer(
    response: import('../../shared/types').AskUserQuestionResponse,
  ): Promise<void> {
    // Channel mode
    if (this.channelService && this.channelService.isConversationActive(response.conversationId)) {
      this.channelService.handleQuestionAnswer(response);
      return;
    }

    // SDK mode
    const instance = this.activeSessions.get(response.conversationId);
    if (!instance) {
      logger.warn('Cannot deliver question answer - no active session', {
        conversationId: response.conversationId,
        actionId: response.actionId,
      });
      return;
    }
    instance.permissionManager.handleQuestionAnswer(response);
  }

  /**
   * Push a `[User answered AskUserQuestion]:` follow-up message into the session's
   * input channel so the model treats the answer as direct user intent (CLI convention).
   */
  private pushAskUserQuestionFollowUp(conversationId: string, text: string): void {
    const session = this.activeSessions.get(conversationId);
    if (!session) {
      logger.warn('Cannot push question follow-up - no active session', { conversationId });
      return;
    }

    const userMessage: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      ...(session.sdkSessionId ? { session_id: session.sdkSessionId } : {}),
      origin: HUMAN_ORIGIN,
    };

    session.inputChannel.push(userMessage);
    logger.info('Pushed AskUserQuestion follow-up user message', {
      conversationId,
      textLength: text.length,
    });
  }

  /**
   * Interrupt the current turn for a conversation without killing the session.
   *
   * Sends SIGINT via query.interrupt() — the CLI cancels the current operation
   * and sends a result message (with terminal_reason 'aborted_streaming' or
   * 'aborted_tools'). The processMessageLoop receives this result and emits done.
   * The session stays alive for subsequent messages — no --resume needed.
   *
   * Falls back to hard termination only if interrupt() itself fails.
   */
  /**
   * Stop one running background task, leaving the session itself running.
   *
   * Distinct from {@link abort}, which tears down the whole turn. Only the SDK
   * path can do this: the control request goes over the session's own channel,
   * and channel mode drives the CLI through a PTY with no such channel. A
   * caller is told rather than silently ignored, since "nothing happened" on
   * a kill button is the worst outcome.
   */
  async stopBackgroundTask(conversationId: string, taskId: string): Promise<void> {
    if (this.channelService && this.channelService.isConversationActive(conversationId)) {
      throw new Error('Stopping a background task is not supported in channel mode');
    }

    const instance = this.activeSessions.get(conversationId);
    if (!instance) {
      throw new Error('That conversation has no running session, so its tasks cannot be stopped');
    }

    logger.info('Stopping background task', { conversationId, taskId });
    await instance.query.stopTask(taskId);
  }

  /**
   * A background task's output from `fromByte` on, or null when there is no
   * output file to read (yet).
   *
   * The file is the one the CLI named in a structured field when it did, and
   * otherwise the one found under its temp root by the session and task ids.
   * The session id is the live session's, or the one the renderer has on
   * record for a conversation with no live session.
   */
  async readTaskOutput(
    conversationId: string,
    taskId: string,
    sdkSessionId: string | undefined,
    fromByte: number,
  ): Promise<TaskOutputChunk | null> {
    const session = this.activeSessions.get(conversationId);
    const sessionId = session?.sdkSessionId ?? sdkSessionId;
    const file = session?.messageHandler.getTaskOutputFile(taskId)
      ?? (sessionId ? await locateTaskOutput(cliTempRoot(), sessionId, taskId) : undefined);
    if (!file) return null;
    try {
      return await readTaskOutput(file, fromByte);
    } catch (error) {
      // Not written yet, or cleaned up since: there is nothing to show.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /**
   * An agent task's transcript, as chat messages, read from the file the CLI
   * keeps it in — live while the agent runs, and still there afterwards.
   *
   * The session id is the live session's, or the one the renderer has on
   * record for the conversation when no session is live.
   */
  async getAgentTranscript(
    conversationId: string,
    agentId: string,
    sdkSessionId: string | undefined,
  ): Promise<ChatMessage[]> {
    const session = this.activeSessions.get(conversationId);
    const sessionId = session?.sdkSessionId ?? sdkSessionId;
    if (!sessionId) return [];

    const entries = await getSubagentMessages(sessionId, agentId, {
      ...(session ? { dir: session.workingDirectory } : {}),
    });
    const found: FoundImages[] = [];
    const messages = transcriptToMessages(
      entries,
      (toolUseBlockId, content) => writeToolResultFile(conversationId, toolUseBlockId, content),
      (message, images) => found.push({ message, images }),
    );
    // saveOnce: the transcript is read again every few seconds while the
    // agent runs, and every read finds the same images.
    await attachTranscriptImages(found, (image) => this.imageStore.saveOnce(conversationId, image));
    return messages;
  }

  async abort(conversationId: string): Promise<void> {
    // Channel mode abort
    if (this.channelService && this.channelService.isConversationActive(conversationId)) {
      await this.channelService.abort(conversationId);
      this.emitDone(conversationId);
      return;
    }

    const instance = this.activeSessions.get(conversationId);
    if (!instance) {
      logger.debug('No active session to abort', { conversationId });
      return;
    }

    // Clear pending permissions (dismisses permission dialogs immediately)
    instance.permissionManager.clearPendingPermissions();

    try {
      await instance.query.interrupt();
      logger.info('Turn interrupted — session preserved for next message', { conversationId });
    } catch (error) {
      logger.warn('Could not interrupt session, falling back to hard termination', {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.terminateSession(conversationId);
    }
  }

  /**
   * Hard-kill a session: abort the subprocess, close the channel, remove from active sessions.
   * Used only for app shutdown (abortAll) or as a fallback when interrupt fails.
   */
  private terminateSession(conversationId: string): void {
    const instance = this.activeSessions.get(conversationId);
    if (!instance) return;

    instance.permissionManager.clearPendingPermissions();
    instance.abortController.abort();
    this.cleanupSession(conversationId);
    this.emitDone(conversationId);

    logger.info('Session terminated (hard kill)', { conversationId });
  }

  /**
   * Terminate all active sessions (e.g., when app is closing)
   */
  async abortAll(): Promise<void> {
    // Shut down channel service if active
    if (this.channelService) {
      await this.channelService.shutdown();
      this.channelService = null;
    }

    const conversationIds = Array.from(this.activeSessions.keys());
    logger.info('Terminating all active sessions for shutdown', { count: conversationIds.length });

    for (const id of conversationIds) {
      this.terminateSession(id);
    }
  }

  /**
   * Check if any authentication is configured
   */
  async hasAuth(): Promise<boolean> {
    return await this.authValidator.hasAuth();
  }

  /**
   * Emit a text chunk to the renderer for a specific conversation
   */
  private emitChunk(conversationId: string, chunk: string): void {
    this.send(IPC_CHANNELS.CLAUDE_CHUNK, conversationId, chunk);
  }

  /**
   * Emit a tool use event to the renderer for permission request
   */
  private emitToolUse(conversationId: string, action: PendingAction): void {
    this.send(IPC_CHANNELS.CLAUDE_TOOL_USE, conversationId, action);
    this.notificationService.showPermissionRequest(conversationId, action.toolName, action.description);
  }

  /**
   * Handle authentication invalidation (e.g. 401 from API).
   * Clears Philibert's login, notifies renderer, and aborts all active
   * sessions. Idempotent: no-ops if the login is already cleared.
   *
   * A login that is the CLI's own is not deleted from the CLI here: it is the
   * terminal's login too, and logging in again replaces it anyway.
   */
  private async handleAuthInvalidated(): Promise<void> {
    const token = await this.configService.getOAuthToken();
    if (!token) return;

    logger.warn('Auth invalidated — clearing credentials and notifying renderer');
    try {
      await this.configService.setConfig({ oauthToken: '', authMethod: 'none' as const });
      await this.configService.setUsesCliLogin(false);

      // Note: we intentionally do NOT bulk-clear persisted sdkSessionIds here.
      // Same-account re-login usually leaves session IDs valid on Anthropic's
      // side, and any actually-stale ID gets caught + cleared by the per-session
      // resume-error handlers (onAuthError in createSessionCallbacks and the
      // isResumeAttempt branch in handleQueryError). Wiping every conversation's
      // resume pointer preemptively destroyed context users cared about.

      // Notify renderer via config change (triggers reactive hasAuth → false)
      this.send(IPC_CHANNELS.CONFIG_CHANGED, { oauthToken: '', authMethod: 'none' });
      // Fire dedicated event for targeted "session expired" messaging
      this.send(IPC_CHANNELS.AUTH_INVALIDATED);

      // Show error on all active conversations and abort them
      for (const convId of this.activeSessions.keys()) {
        this.emitError(convId, 'Your session has expired. Please log out and log in again in Settings.');
      }
      await this.abortAll();
    } catch (err) {
      logger.error('Failed to clear invalidated auth credentials', { err });
    }
  }

  /**
   * Emit an error to the renderer for a specific conversation
   */
  private emitError(conversationId: string, error: string): void {
    this.send(IPC_CHANNELS.CLAUDE_ERROR, conversationId, error);
    this.notificationService.showError(conversationId, error);
  }

  /**
   * End a turn that is still marked busy but has nothing left to produce.
   *
   * The renderer's spinner is cleared only by CLAUDE_DONE, so any path that
   * leaves a turn un-ended strands it permanently — there is no timeout and no
   * other way back. Turn completion normally rides on a user-originated
   * `result`, but a turn whose only result is background-origin produces none,
   * and the stream can simply end without one.
   *
   * Silent by design: no completion notification, because this is a turn that
   * did not complete in the ordinary sense.
   */
  private endStrandedTurn(conversationId: string, reason: string): void {
    const session = this.activeSessions.get(conversationId);
    if (session) session.unpromptedTurn = false;
    if (!this.processingSessions.has(conversationId)) {
      logger.info('[turn] backstop no-op', { conversationId, reason, stillProcessing: false });
      return;
    }
    logger.warn('[turn] backstop fired — turn was still marked processing', {
      conversationId,
      reason,
    });
    this.processingSessions.delete(conversationId);
    this.emitActiveQueryCount();
    this.send(IPC_CHANNELS.CLAUDE_DONE, conversationId);
  }

  /**
   * The CLI started a turn. When nobody sent anything, it is the CLI's own
   * answer to a background task finishing: it streams text and runs tools
   * like any turn, so the conversation is busy for it too — counted as
   * running, with the renderer told a turn has begun so it shows activity and
   * collects the turn as it would one the user sent.
   *
   * A turn the user sent is already marked busy when sent, which is what
   * leaves this a no-op for it.
   */
  private beginUnpromptedTurn(conversationId: string): void {
    const session = this.activeSessions.get(conversationId);
    if (!session || this.processingSessions.has(conversationId)) return;
    logger.info('[turn] started by the CLI', { conversationId });
    session.unpromptedTurn = true;
    this.processingSessions.add(conversationId);
    // Before the running set, which the renderer also marks busy from: the
    // turn-start handler is what records where the turn begins.
    this.send(IPC_CHANNELS.CLAUDE_TURN_STARTED, conversationId);
    this.emitActiveQueryCount();
  }

  /**
   * Emit done event to the renderer for a specific conversation — the end of
   * a turn the user sent, or of one the CLI started by itself.
   */
  private emitDone(conversationId: string, unprompted = false): void {
    logger.info('[turn] done', { conversationId, unprompted });
    this.processingSessions.delete(conversationId);
    this.emitActiveQueryCount();
    this.send(IPC_CHANNELS.CLAUDE_DONE, conversationId);
    void this.notificationService.showTurnEnded(conversationId, this.runningTasks(conversationId).length);
  }

  /**
   * Emit a system note to the renderer (rendered as a separator, not inline text)
   */
  private emitSystemNote(conversationId: string, note: string): void {
    this.send(IPC_CHANNELS.CLAUDE_SYSTEM_NOTE, conversationId, note);
  }

  /**
   * Emit slash commands to the renderer
   */
  private emitSlashCommands(conversationId: string, commands: SlashCommandInfo[]): void {
    this.send(IPC_CHANNELS.CLAUDE_SLASH_COMMANDS, conversationId, commands);
  }

  /**
   * Emit task notification to the renderer
   */
  private emitTaskNotification(conversationId: string, notification: TaskNotification): void {
    this.send(IPC_CHANNELS.CLAUDE_TASK_NOTIFICATION, conversationId, notification);
  }

  /**
   * Emit tool executed event to the renderer so inline indicators update
   */
  private emitToolExecuted(conversationId: string, actionId: string): void {
    this.send(IPC_CHANNELS.CLAUDE_TOOL_EXECUTED, conversationId, actionId);
  }

  /**
   * Emit usage update to the renderer
   */
  private emitUsageUpdate(conversationId: string, usage: SessionUsage): void {
    this.send(IPC_CHANNELS.CLAUDE_USAGE_UPDATE, conversationId, usage);
  }

  /**
   * Emit session ID to the renderer for conversation continuity
   */
  private emitSessionId(conversationId: string, sessionId: string): void {
    logger.info('Emitting SDK session ID to renderer', { conversationId, sessionId: sessionId.slice(0, 20) + '...' });
    this.send(IPC_CHANNELS.CLAUDE_SESSION_ID, conversationId, sessionId);
  }

  /**
   * Clear a stale session ID in the renderer.
   * Sends empty string via the existing session ID channel — the renderer
   * interprets this as "delete the stored session ID for this conversation".
   */
  private emitClearSessionId(conversationId: string): void {
    logger.info('Clearing stale SDK session ID in renderer', { conversationId });
    this.send(IPC_CHANNELS.CLAUDE_SESSION_ID, conversationId, '');
  }

  /**
   * Check if an error message indicates a failed session resume (stale/expired session ID).
   */
  private isResumeSessionError(errorMessage: string): boolean {
    const lower = errorMessage.toLowerCase();
    return lower.includes('no conversation found') ||
           lower.includes('session not found') ||
           lower.includes('no session found');
  }

  /**
   * Get available slash commands
   * Returns cached commands from the last SDK init message
   */
  /**
   * Subagents the session can delegate to, from the SDK.
   *
   * Same shape as getSlashCommands(): cache, then a live session, then a
   * throwaway query, because `/agents` has to answer before any conversation
   * exists. supportedAgents() is a free control command.
   */
  async getAgents(): Promise<AgentInfo[]> {
    if (this.cachedAgents.length > 0) {
      return this.cachedAgents;
    }

    for (const instance of this.activeSessions.values()) {
      try {
        const agents = await instance.query.supportedAgents();
        this.cachedAgents = agents.map(ClaudeCodeService.toAgentInfo);
        logger.info('Fetched agents from session', { count: this.cachedAgents.length });
        return this.cachedAgents;
      } catch (error) {
        logger.warn('Failed to fetch agents from session', { error });
      }
    }

    await this.withTemporaryQuery('supportedAgents', async (tempQuery) => {
      const agents = await tempQuery.supportedAgents();
      this.cachedAgents = agents.map(ClaudeCodeService.toAgentInfo);
      logger.info('Fetched agents via temporary session', { count: this.cachedAgents.length });
    });

    return this.cachedAgents;
  }

  private static toAgentInfo(agent: SDKAgentInfo): AgentInfo {
    return {
      name: agent.name,
      description: agent.description,
      ...(agent.model ? { model: agent.model } : {}),
    };
  }

  /**
   * What a rewind to `messageUuid` would restore, without restoring anything.
   *
   * A dry run, because restoring files overwrites the working tree and nothing
   * in this app can undo that — the user gets to see the file list and the
   * line counts first.
   *
   * Note the SDK's caveat on the preview: `skippedLinks` "is never set" on a
   * dry run "and the preview counts do not reflect link-safety refusals", so a
   * real rewind can still skip files this preview counted. The outcome reports
   * that, which is why it is shown afterwards too.
   */
  async previewRewind(conversationId: string, messageUuid: string): Promise<RewindPreview> {
    const session = this.activeSessions.get(conversationId);
    if (!session) {
      return {
        canRewind: false,
        error:
          'This conversation has no live Claude Code session, so there are no file ' +
          'checkpoints to restore from. Checkpoints last as long as the session.',
        filesChanged: [],
        insertions: 0,
        deletions: 0,
      };
    }

    try {
      const result = await session.query.rewindFiles(messageUuid, { dryRun: true });
      return {
        canRewind: result.canRewind,
        ...(result.error ? { error: result.error } : {}),
        filesChanged: result.filesChanged ?? [],
        insertions: result.insertions ?? 0,
        deletions: result.deletions ?? 0,
      };
    } catch (error) {
      logger.warn('Rewind preview failed', { conversationId, messageUuid, error });
      return {
        canRewind: false,
        error: error instanceof Error ? error.message : String(error),
        filesChanged: [],
        insertions: 0,
        deletions: 0,
      };
    }
  }

  /**
   * Rewind to `messageUuid`.
   *
   * Files first, then the conversation. That order matters: rewinding the
   * conversation ends the session, and the session is what holds the file
   * checkpoints, so doing it the other way round would throw away the
   * checkpoints before they had been used.
   *
   * A conversation rewind does not happen here — it is a property of how the
   * next session starts. The point is recorded and the session closed; the next
   * message resumes at that turn with everything after it dropped.
   */
  async applyRewind(
    conversationId: string,
    messageUuid: string,
    scope: RewindScope,
  ): Promise<RewindOutcome> {
    const wantsFiles = scope === 'code' || scope === 'both';
    const wantsConversation = scope === 'conversation' || scope === 'both';

    let filesChanged: string[] = [];
    let insertions = 0;
    let deletions = 0;
    let skippedLinks: number | undefined;

    if (wantsFiles) {
      const session = this.activeSessions.get(conversationId);
      if (!session) {
        return {
          ok: false,
          error:
            'This conversation has no live Claude Code session, so there are no file ' +
            'checkpoints to restore from. Checkpoints last as long as the session.',
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          conversationRewound: false,
        };
      }

      try {
        const result = await session.query.rewindFiles(messageUuid);
        if (!result.canRewind) {
          return {
            ok: false,
            error: result.error ?? 'Claude Code refused the rewind without giving a reason.',
            filesChanged: [],
            insertions: 0,
            deletions: 0,
            conversationRewound: false,
          };
        }
        filesChanged = result.filesChanged ?? [];
        insertions = result.insertions ?? 0;
        deletions = result.deletions ?? 0;
        skippedLinks = result.skippedLinks;
      } catch (error) {
        logger.error('Rewind failed', { conversationId, messageUuid, error });
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          conversationRewound: false,
        };
      }
    }

    if (wantsConversation) {
      this.pendingRewindPoints.set(conversationId, messageUuid);
      // Ends the session so the next message starts one with resumeSessionAt.
      this.cleanupSession(conversationId);
      logger.info('Conversation rewind armed', { conversationId, messageUuid });
    }

    return {
      ok: true,
      filesChanged,
      insertions,
      deletions,
      ...(skippedLinks ? { skippedLinks } : {}),
      conversationRewound: wantsConversation,
    };
  }

  /**
   * Available slash commands, from the SDK.
   *
   * Mirrors getModels(): cache, then any live session, then a throwaway query.
   * The last step is what matters — this is called when the renderer mounts,
   * before any conversation exists, and returning an empty list there left the
   * prompt box with nothing to autocomplete, so the commands appeared not to
   * exist at all until after the first message of a session.
   */
  async getSlashCommands(): Promise<SlashCommandInfo[]> {
    if (this.cachedSlashCommands.length > 0) {
      return this.cachedSlashCommands;
    }

    for (const instance of this.activeSessions.values()) {
      try {
        const commands = await instance.query.supportedCommands();
        this.cachedSlashCommands = commands.map((cmd) => ClaudeCodeService.toSlashCommandInfo(cmd));
        logger.info('Fetched slash commands from session', { count: this.cachedSlashCommands.length });
        return this.cachedSlashCommands;
      } catch (error) {
        logger.warn('Failed to fetch slash commands from session', { error });
      }
    }

    await this.withTemporaryQuery('supportedCommands', async (tempQuery) => {
      const commands = await tempQuery.supportedCommands();
      this.cachedSlashCommands = commands.map((cmd) => ClaudeCodeService.toSlashCommandInfo(cmd));
      logger.info('Fetched slash commands via temporary session', {
        count: this.cachedSlashCommands.length,
      });
      // No emit here: this path is driven by the renderer's own getCommands()
      // call and the awaited return value is what it assigns. The
      // CLAUDE_SLASH_COMMANDS push exists for the SDK's mid-session changes,
      // which carry a conversation.
    });

    return this.cachedSlashCommands;
  }

  /**
   * Build the managed-settings block applied to the spawned CLI process.
   *
   * The SDK documents `managedSettings` as being "intended for embedding
   * applications (e.g. desktop apps) that derive lockdown settings from their
   * own enterprise configuration and need to enforce them on the spawned
   * subprocess without writing root-owned files" — exactly this case. Managed
   * settings outrank user and project settings, so `.claude/settings.json`
   * cannot quietly redirect the session to another model.
   *
   * Returns undefined when there is nothing to enforce, so the CLI keeps its
   * stock behaviour.
   */
  private async buildManagedSettings(
    selectedModel: string,
  ): Promise<Record<string, unknown> | undefined> {
    const switchModelsOnFlag = await this.configService.getSwitchModelsOnFlag();
    const strict = await this.configService.getStrictModelEnforcement();

    const settings: Record<string, unknown> = {};

    // Only pin when the user actually picked something; an empty selection
    // means "let Claude Code decide", which we report rather than override.
    if (selectedModel) {
      settings.model = selectedModel;

      if (strict) {
        // The CLI checks every model change against this allowlist, including
        // server-proposed refusal-fallback targets — it logs "Server
        // refusal-fallback target … is not in the availableModels allowlist;
        // declining the swap" and keeps the current model. enforceAvailableModels
        // additionally constrains the Default selection to the allowlist.
        settings.availableModels = [selectedModel];
        settings.enforceAvailableModels = true;
      }
    }

    // Claude Code defaults this to true. When false the CLI pauses the session
    // on a flagged message instead of swapping models behind the user's back.
    if (!switchModelsOnFlag) {
      settings.switchModelsOnFlag = false;
    }

    if (Object.keys(settings).length === 0) return undefined;

    logger.info('Applying managed settings to CLI subprocess', {
      model: settings.model ?? '(not pinned)',
      strictModelEnforcement: strict,
      switchModelsOnFlag,
    });

    return settings;
  }

  /**
   * Environment overrides that extend model enforcement to the CLI's *other*
   * model slot.
   *
   * `--model` and `managedSettings.model` govern the main loop only. The CLI
   * resolves a second, dedicated "small fast model" through a separate path
   * (`getSmallFastModel` / `hasDedicatedSmallFastModel` in the bundle) and
   * uses it for internal work — conversation titles, summaries, the
   * permission classifier. That model is Haiku by default and is completely
   * untouched by the main-loop selection, so a session pinned to Opus still
   * legitimately reports Haiku usage.
   *
   * Only applied under strict enforcement, because forcing utility work onto
   * a frontier model is a real cost increase — titles and summaries would run
   * on Opus. Off by default, the CLI's own behaviour is preserved and the
   * usage bar surfaces the secondary model instead of hiding it.
   */
  private async buildModelEnforcementEnv(selectedModel: string): Promise<Record<string, string>> {
    if (!selectedModel) return {};
    if (!(await this.configService.getStrictModelEnforcement())) return {};

    logger.info('Pinning the CLI small-fast model to the selected model', {
      model: selectedModel,
    });
    return { ANTHROPIC_SMALL_FAST_MODEL: selectedModel };
  }

  /**
   * Reconcile the model the CLI says it is running against the model the user
   * selected, and tell the user whenever they differ.
   *
   * A mismatch is not necessarily a fault — Claude Code legitimately changes
   * models on a safety-classifier refusal, on a rate-limit fallback, via
   * `fallbackModel` when the primary is overloaded, and per-sub-agent when an
   * agent definition names its own model. What is NOT acceptable is any of
   * that happening invisibly, which is what an embedded SDK host gets by
   * default: interactive Claude Code prompts the user with a dialog, but with
   * no dialog host the CLI swaps silently.
   *
   * Reported once per (source, model) pair per session so a long run doesn't
   * spam the transcript.
   */
  private reconcileReportedModel(
    conversationId: string,
    reportedModel: string,
    source: ModelReportSource,
  ): void {
    const session = this.activeSessions.get(conversationId);
    if (!session) return;

    // The CLI stamps `<synthetic>` on assistant messages it fabricates itself
    // — quota and rate-limit notices above all. Those carry no model, and
    // reporting one as a substitution replaces the real error the user needs
    // to see ("you selected Opus 4.8, but Claude Code is running <synthetic>")
    // with something meaningless.
    if (!isRealModelId(reportedModel)) return;

    // Track what the main thread is actually on, so a later setModel() diff
    // is computed against reality rather than against what we asked for, and
    // tell the renderer so the picker can show the resolved model.
    if (source !== 'subagent') {
      if (session.sessionModel !== reportedModel) {
        this.send(IPC_CHANNELS.CLAUDE_ACTIVE_MODEL, conversationId, reportedModel);
      }
      session.sessionModel = reportedModel;
    }

    const requested = session.requestedModel;
    // No explicit selection means the user asked for the CLI default; there is
    // nothing to contradict, but surface what that resolved to so "Default"
    // is never an unanswered question.
    if (!requested) {
      const key = `default:${stripDateSuffix(reportedModel)}`;
      if (source === 'init' && !session.announcedModels.has(key)) {
        session.announcedModels.add(key);
        this.emitSystemNote(
          conversationId,
          `Model: ${formatModelId(reportedModel)} (chosen by Claude Code — no model pinned)`,
        );
      }
      return;
    }

    // A pinned snapshot ('claude-sonnet-4-5-20250929') is the same model as its
    // alias. Not a substitution.
    if (isSameModel(requested, reportedModel)) return;

    // A family alias ('opus') legitimately resolves to a concrete ID. The SDK
    // publishes that mapping as `resolvedModel` on the alias row precisely so a
    // host can match a persisted selection against the model actually running;
    // fall back to comparing families only when the row isn't cached yet.
    const requestedRow = this.cachedModels.find((m) => m.value === requested);
    if (requestedRow?.resolvedModel && isSameModel(requestedRow.resolvedModel, reportedModel)) return;
    if (!requestedRow?.resolvedModel && familyKeyOf(reportedModel) === familyKeyOf(requested)) return;

    const key = `${source}:${stripDateSuffix(reportedModel)}`;
    if (session.announcedModels.has(key)) return;
    session.announcedModels.add(key);

    const requestedLabel = formatModelId(requested);
    const reportedLabel = formatModelId(reportedModel);

    logger.warn('Reported model differs from the selected model', {
      conversationId,
      source,
      requested,
      reported: reportedModel,
    });

    if (source === 'subagent') {
      // Expected when an agent definition names a model — Claude Code's
      // documented behaviour is that sub-agents inherit the main model unless
      // their own definition overrides it. Still worth saying out loud.
      this.emitSystemNote(
        conversationId,
        `Background agent is running ${reportedLabel}, not ${requestedLabel}. ` +
        'A sub-agent uses its own model when its definition sets one ' +
        '(the `model:` field in .claude/agents/*.md); otherwise it inherits your selection.',
      );
      return;
    }

    this.emitSystemNote(
      conversationId,
      `Model mismatch: you selected ${requestedLabel}, but Claude Code is running ${reportedLabel}.`,
    );
  }

  /**
   * Surface a model swap the CLI performed after a safety-classifier refusal.
   *
   * Interactive Claude Code asks first ("Switch to <model>?"); an embedded
   * consumer with no dialog host gets the swap done for it, and the swap is
   * persistent for the rest of the session. Setting `switchModelsOnFlag` to
   * false in managed settings makes the session pause instead.
   */
  private reportModelSubstitution(conversationId: string, event: ModelSubstitutionEvent): void {
    const session = this.activeSessions.get(conversationId);
    const reason = event.category ? ` (flagged: ${event.category})` : '';

    if (!event.fallbackModel) {
      this.emitSystemNote(
        conversationId,
        `${formatModelId(event.originalModel)} declined this message${reason} and no fallback ran. ` +
        (event.explanation ? `${event.explanation} ` : '') +
        'The model is unchanged.',
      );
      return;
    }

    if (session) {
      session.sessionModel = event.fallbackModel;
      // Let reconcileReportedModel speak again if the model moves again later.
      session.announcedModels.clear();
    }

    logger.warn('CLI substituted the model after a refusal', {
      conversationId,
      originalModel: event.originalModel,
      fallbackModel: event.fallbackModel,
      category: event.category,
    });

    this.emitSystemNote(
      conversationId,
      `Claude Code switched from ${formatModelId(event.originalModel)} to ` +
      `${formatModelId(event.fallbackModel)}${reason} and will stay on it for this session. ` +
      'Turn off "Allow model switch when a message is flagged" in Settings to pause instead of switching.',
    );
  }

  /**
   * Get available models from the SDK
   * Returns cached models if available
   */
  async getModels(): Promise<ModelInfo[]> {
    if (this.cachedModels.length > 0) {
      return this.cachedModels;
    }

    // Try to fetch from any active session
    for (const instance of this.activeSessions.values()) {
      try {
        const models = await instance.query.supportedModels();
        this.cachedModels = ClaudeCodeService.mergeWithKnownModels(
          models.map((m) => ClaudeCodeService.toModelInfo(m)),
        );
        logger.info('Fetched models from SDK', { count: this.cachedModels.length });
        return this.cachedModels;
      } catch (error) {
        logger.warn('Failed to fetch models from session', { error });
      }
    }

    // No active sessions — spawn a temporary SDK query to fetch models.
    // supportedModels() is a free control command (no token cost).
    try {
      await this.fetchModelsViaTemporarySession();
      if (this.cachedModels.length > 0) {
        return this.cachedModels;
      }
    } catch (error) {
      logger.warn('Failed to fetch models via temporary session', { error });
    }

    return [];
  }

  /**
   * The account the current login belongs to — email, organization, plan.
   *
   * Asked of the CLI, which reads it from the account behind the
   * credentials; the login flow itself only ever receives tokens. A session
   * running under the current login answers it; otherwise a throwaway query
   * does, which is a free control command. Null when it could not be read.
   */
  async getAccountInfo(): Promise<ClaudeAccount | null> {
    const generation = this.authGeneration;
    if (this.cachedAccount?.generation === generation) return this.cachedAccount.account;
    if (this.accountRequest?.generation === generation) return this.accountRequest.promise;

    const promise = this.readAccountInfo()
      .then((account) => {
        // Filed under the login it was read for, so an answer that arrives
        // after the login changed is never handed out for the new one.
        if (account) {
          this.cachedAccount = { generation, account };
        }
        return account;
      })
      .finally(() => {
        if (this.accountRequest?.promise === promise) this.accountRequest = null;
      });
    this.accountRequest = { generation, promise };
    return promise;
  }

  private async readAccountInfo(): Promise<ClaudeAccount | null> {
    for (const instance of this.activeSessions.values()) {
      // A session left over from the previous login would report that one.
      if (instance.authGeneration !== this.authGeneration) continue;
      try {
        return ClaudeCodeService.toClaudeAccount(await instance.query.accountInfo());
      } catch (error) {
        logger.warn('Failed to read account info from session', { error });
      }
    }
    return this.withTemporaryQuery('accountInfo', async (tempQuery) =>
      ClaudeCodeService.toClaudeAccount(await tempQuery.accountInfo()));
  }

  /** Only the fields shown, and only when the CLI reported them as text. */
  private static toClaudeAccount(info: AccountInfo): ClaudeAccount {
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
    const email = text(info.email);
    const organization = text(info.organization);
    const subscriptionType = text(info.subscriptionType);
    // A bare token — the `setup-token` logins made before `auth login` —
    // names no account, and the CLI says so by reporting only where the token
    // came from. Told apart from a read that failed, which it is not.
    const tokenOnly = info.tokenSource === 'CLAUDE_CODE_OAUTH_TOKEN';
    return {
      ...(tokenOnly ? { tokenOnly } : {}),
      ...(email ? { email } : {}),
      ...(organization ? { organization } : {}),
      ...(subscriptionType ? { subscriptionType } : {}),
    };
  }

  /**
   * Run a control command against a throwaway SDK query.
   *
   * The query is created with an input channel nothing is ever pushed to, so
   * the CLI starts, answers the control command and is aborted without a turn
   * ever running — `supportedModels()` and `supportedCommands()` are both free
   * and cost no tokens. This is the only way to answer "what can I do?" before
   * the user has sent a first message.
   *
   * Returns null when there are no credentials, since the CLI cannot start.
   */
  private async withTemporaryQuery<T>(
    label: string,
    use: (tempQuery: Query) => Promise<T>,
  ): Promise<T | null> {
    const hasAuthCreds = await this.authValidator.hasAuth();
    if (!hasAuthCreds) return null;

    const authEnv = await this.authValidator.setupAuthEnv();
    const originalEnv: Record<string, string | undefined> = {};
    Object.entries(authEnv).forEach(([key, value]) => {
      originalEnv[key] = process.env[key];
      process.env[key] = value;
    });

    const abortController = new AbortController();
    const inputChannel = new AsyncChannel<SDKUserMessage>();

    try {
      const tempQuery = query({
        prompt: inputChannel,
        options: {
          abortController,
          env: authEnv,
          pathToClaudeCodeExecutable: ClaudeCliPaths.findBundledCli() || undefined,
        },
      });

      return await use(tempQuery);
    } catch (error) {
      logger.warn('Temporary SDK query failed', { label, error });
      return null;
    } finally {
      abortController.abort();
      inputChannel.close();
      Object.entries(originalEnv).forEach(([key, value]) => {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      });
    }
  }

  private async fetchModelsViaTemporarySession(): Promise<void> {
    await this.withTemporaryQuery('supportedModels', async (tempQuery) => {
      const models = await tempQuery.supportedModels();
      this.cachedModels = ClaudeCodeService.mergeWithKnownModels(
        models.map((m) => ClaudeCodeService.toModelInfo(m)),
      );
      logger.info('Fetched models via temporary session', { count: this.cachedModels.length });
      this.send(IPC_CHANNELS.CLAUDE_MODEL_CHANGED, this.cachedModels);
    });
  }

  /**
   * Update cached models from SDK (called after session init)
   */
  private async fetchAndCacheModels(queryIterator: Query): Promise<void> {
    try {
      const models = await queryIterator.supportedModels();
      this.cachedModels = ClaudeCodeService.mergeWithKnownModels(
        models.map((m) => ClaudeCodeService.toModelInfo(m)),
      );
      logger.info('Cached models from SDK', {
        count: this.cachedModels.length,
        models: this.cachedModels.map(m => ({ value: m.value, displayName: m.displayName })),
      });
      this.send(IPC_CHANNELS.CLAUDE_MODEL_CHANGED, this.cachedModels);
    } catch (error) {
      logger.warn('Failed to fetch models for caching', error);
    }
  }

  /**
   * Known model versions per family, derived from the naming convention at
   * https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions
   *
   * Model ID format: claude-{family}-{major}-{minor}
   * Display name:    Claude {Family} {major}.{minor}
   */
  private static readonly MODEL_CATALOG: readonly CatalogEntry[] = [
    // Claude 5 generation — single-segment version IDs (no minor), except the
    // 5.5 refresh, which reintroduced the minor segment (`claude-opus-5-5`).
    { family: 'opus',   major: 5, minor: 5, context: '1M' },
    { family: 'opus',   major: 5,           context: '1M' },
    { family: 'fable',  major: 5,           context: '1M' },
    { family: 'sonnet', major: 5,           context: '1M' },
    // Claude 4 generation — {major}-{minor} version IDs.
    { family: 'opus',   major: 4, minor: 8, context: '1M' },
    { family: 'opus',   major: 4, minor: 7, context: '1M' },
    { family: 'opus',   major: 4, minor: 6, context: '1M' },
    { family: 'opus',   major: 4, minor: 5, context: '200K' },
    { family: 'sonnet', major: 4, minor: 6, context: '1M' },
    { family: 'sonnet', major: 4, minor: 5, context: '200K' },
    { family: 'haiku',  major: 4, minor: 5, context: '200K' },
  ];

  /**
   * Display order for known families. Fable sits next to Opus because it is
   * the tier above it; anything the SDK grows into lands after these.
   */
  private static readonly FAMILY_ORDER = ['opus', 'fable', 'sonnet', 'haiku'];

  /** Canonical alias for a catalog entry, e.g. `claude-opus-5`, `claude-opus-4-8`. */
  private static catalogAlias(entry: CatalogEntry): string {
    return entry.minor === undefined
      ? `claude-${entry.family}-${entry.major}`
      : `claude-${entry.family}-${entry.major}-${entry.minor}`;
  }

  /**
   * Family-level context-window default, used as fallback when a specific
   * catalog entry doesn't exist for a model (e.g. a brand-new SKU that ships
   * before the catalog is updated). Only Haiku currently sits at 200K; every
   * other current family ships at 1M, and new families are assumed to follow
   * the same trend unless they announce otherwise.
   */
  private static readonly FAMILY_DEFAULT_CONTEXT: Record<string, string> = {
    haiku: '200K',
  };

  private static contextForFamily(family: string): string {
    return ClaudeCodeService.FAMILY_DEFAULT_CONTEXT[family] ?? '1M';
  }

  /**
   * The effort level to send for a selected model, or null to send none.
   *
   * The requested level is the user's; what a model accepts is the SDK's to
   * report. A selection can name an alias row (`opus[1m]`) or a concrete
   * version the alias resolves to, and only one of those rows carries the
   * capability fields — so look for either before concluding a model takes no
   * effort. With no cached row at all the request is passed through unclamped
   * and the CLI downgrades it if need be; suppressing effort because the list
   * has not loaded would silently ignore the user's choice on the first turn.
   */
  private async resolveEffortForModel(selectedModel: string): Promise<EffortLevel | null> {
    const requested = await this.configService.getEffortLevel();
    return resolveEffortForSelection(requested, selectedModel, this.cachedModels);
  }

  /**
   * Project an SDK model row onto the app's own {@link ModelInfo}.
   *
   * The SDK reports more than identity — capability flags travel on the same
   * row — and the effort picker is driven entirely by `supportedEffortLevels`
   * rather than by anything hardcoded here, so those fields have to survive
   * the hop. Shared by every `supportedModels()` call site so a newly
   * surfaced field only has to be added once.
   */
  private static toModelInfo(m: SDKModelInfo): ModelInfo {
    return {
      value: m.value,
      resolvedModel: m.resolvedModel,
      displayName: m.displayName,
      description: m.description,
      ...(m.supportsEffort !== undefined && { supportsEffort: m.supportsEffort }),
      ...(m.supportedEffortLevels && { supportedEffortLevels: [...m.supportedEffortLevels] }),
    };
  }

  /**
   * Reduce any model ID to the identity two rows are deduplicated on.
   *
   * Drops a dated snapshot suffix (`-20250929`) and a context-window variant
   * (`[1m]`), because neither names a different model: `claude-opus-5-5` and
   * `claude-opus-5-5[1m]` are one model offered at two context widths. Keeping
   * the variant on the key made the catalog's Opus 5.5 row look distinct from
   * the `[1m]` ID the `opus` alias resolves to, so the picker listed Opus 5.5
   * twice. The variant still belongs in the row's `value` — that is what gets
   * handed to the CLI — just not in its identity. See @shared/model-id.
   */
  private static toAlias(modelId: string): string {
    return stripContextVariant(stripDateSuffix(modelId));
  }

  /**
   * Merge SDK-returned models with the known catalog.
   * Deduplicates by alias (so dated SDK IDs like claude-sonnet-4-5-20250929
   * match catalog entry claude-sonnet-4-5). Result is grouped by family
   * (known families first, unknowns after) and sorted by version descending
   * within each family. Context annotation falls back to a family-level
   * default when a specific catalog entry isn't present.
   */
  static mergeWithKnownModels(sdkModels: ModelInfo[]): ModelInfo[] {
    const seen = new Set<string>();
    const merged: ModelInfo[] = [];

    const catalogByAlias = new Map<string, CatalogEntry>();
    for (const entry of ClaudeCodeService.MODEL_CATALOG) {
      catalogByAlias.set(ClaudeCodeService.catalogAlias(entry), entry);
    }

    for (const sdk of sdkModels) {
      const alias = ClaudeCodeService.toAlias(sdk.value);
      if (seen.has(alias)) continue;
      seen.add(alias);

      const catalogEntry = catalogByAlias.get(alias);
      if (catalogEntry) {
        merged.push({
          ...sdk,
          displayName: formatModelDisplayName({
            family: catalogEntry.family,
            major: catalogEntry.major,
            minor: catalogEntry.minor ?? null,
          }),
          description: `${catalogEntry.context} context`,
        });
      } else {
        // No specific catalog match. Label it from the ID when the ID carries
        // a version: the SDK names its versioned rows after the family — it
        // returns `claude-fable-5-1[1m]` as plain "Fable" — which reads as a
        // family label sitting in the version submenu next to "Claude Opus
        // 4.8". Rows with no version (bare aliases, `default`) keep the SDK's
        // own wording, which is all they have.
        const parsed = parseModelId(alias);
        const description = parsed && !sdk.description
          // Backfill the context annotation from the family default so a
          // freshly-released SKU (Mythos, future families, …) still shows a
          // sensible context hint instead of nothing.
          ? `${ClaudeCodeService.contextForFamily(parsed.family)} context`
          : sdk.description;
        merged.push({
          ...sdk,
          ...(parsed && { displayName: formatModelDisplayName(parsed) }),
          ...(description && { description }),
        });
      }
    }

    // Catalog versions are added ONLY for families the SDK actually offered.
    //
    // Two failure modes to stay between. Adding every catalog entry
    // unconditionally listed whole families the account has no access to —
    // picking one made the CLI fall back to a different model, which then
    // surfaced as a spurious "model mismatch". Adding nothing at all is the
    // opposite error: `supportedModels()` can return only bare family aliases
    // ('opus', 'sonnet', 'haiku'), which left the picker with families and no
    // way to pin a specific version.
    //
    // Scoping to reported families keeps both closed: no Fable row unless the
    // SDK offered Fable, but Opus 4.8 / 4.7 / 4.6 are selectable once Opus is
    // available. Rows the SDK reported directly always win — the catalog only
    // fills in versions it did not enumerate.
    const offeredFamilies = new Set<string>();
    for (const sdk of sdkModels) {
      // familyKeyOf copes with every shape supportedModels() returns: a bare
      // alias ('sonnet'), an alias with a context variant ('opus[1m]'), and a
      // full ID with or without one ('claude-fable-5[1m]').
      const family = familyKeyOf(sdk.value);
      if (family) offeredFamilies.add(family);
      // An alias row names the concrete model it resolves to; that version is
      // known-good for this account even if the catalog has never heard of it.
      const resolvedFamily = sdk.resolvedModel ? familyKeyOf(sdk.resolvedModel) : null;
      if (resolvedFamily) offeredFamilies.add(resolvedFamily);
    }

    for (const sdk of sdkModels) {
      if (!sdk.resolvedModel) continue;
      const alias = ClaudeCodeService.toAlias(sdk.resolvedModel);
      if (seen.has(alias)) continue;
      seen.add(alias);
      const parsed = parseModelId(alias);
      const entry = catalogByAlias.get(alias);
      merged.push({
        value: sdk.resolvedModel,
        displayName: parsed ? formatModelDisplayName(parsed) : sdk.resolvedModel,
        description: entry
          ? `${entry.context} context`
          : `${ClaudeCodeService.contextForFamily(parsed?.family ?? '')} context`,
      });
    }

    for (const entry of ClaudeCodeService.MODEL_CATALOG) {
      if (!offeredFamilies.has(entry.family)) continue;
      const alias = ClaudeCodeService.catalogAlias(entry);
      if (seen.has(alias)) continue;
      seen.add(alias);
      merged.push({
        value: alias,
        displayName: formatModelDisplayName({
          family: entry.family,
          major: entry.major,
          minor: entry.minor ?? null,
        }),
        description: `${entry.context} context`,
      });
    }

    const familyOrder = ClaudeCodeService.FAMILY_ORDER;
    const parseModel = (m: ModelInfo) => {
      const parsed = parseModelId(m.value);
      if (!parsed) return { familyIdx: familyOrder.length + 1, version: 0 };
      const idx = familyOrder.indexOf(parsed.family);
      return {
        // Unknown families (anything the SDK grows into) sort after known ones
        // rather than jumping to the top of the list.
        familyIdx: idx === -1 ? familyOrder.length : idx,
        version: modelVersionRank(m.value),
      };
    };

    merged.sort((a, b) => {
      const pa = parseModel(a);
      const pb = parseModel(b);
      if (pa.familyIdx !== pb.familyIdx) return pa.familyIdx - pb.familyIdx;
      return pb.version - pa.version;
    });

    return merged;
  }
}

export default ClaudeCodeService;
