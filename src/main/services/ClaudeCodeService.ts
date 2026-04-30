/**
 * Service for integrating with @anthropic-ai/claude-code
 *
 * Uses the Claude Code SDK query() function with AsyncIterable prompt
 * for persistent sessions. This keeps the SDK subprocess alive between
 * user turns, allowing background task notifications to flow naturally
 * (matching Claude Code CLI behavior).
 *
 * BACKGROUND TASK NOTIFICATION FLUSHING:
 * The CLI subprocess only emits task_notification messages when processing
 * a user turn. Between turns, notifications accumulate in the CLI's internal
 * queue. To flush these, we periodically send minimal synthetic messages (".")
 * when there are running background tasks. Synthetic turn output is suppressed.
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

import { spawn, type ChildProcess } from 'node:child_process';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Query,
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SpawnOptions,
  SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import { BrowserWindow } from 'electron';

import {
  IPC_CHANNELS,
  PendingAction,
  ActionResponse,
  SlashCommandInfo,
  ModelInfo,
  TaskNotification,
  SessionUsage,
  MAX_CONCURRENT_QUERIES,
  SessionPermissionEntry,
} from '../../shared/types';
import { AsyncChannel } from '../utils/AsyncChannel';
import { createSender } from '../utils/ipc-helpers';
import logger from '../utils/logger';
import { ClaudeCliPaths, WindowsPaths } from '../utils/resourcePaths';

import ConfigService from './ConfigService';
import NotificationService from './NotificationService';
import {
  PermissionManager,
  SDKMessageHandler,
  AuthValidator,
  ErrorHandler,
  BuiltinCommandHandler,
  SessionPermissionCache,
} from './claude';

/**
 * Info about a running background task within a session.
 */
interface RunningBackgroundTask {
  outputFile?: string;
  startedAt: number;
}

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
  /** Running background tasks: taskId -> info */
  runningBackgroundTasks: Map<string, RunningBackgroundTask>;
  /**
   * Number of synthetic poll turns currently queued in the input channel.
   * When > 0, output (chunks, usage, done) is suppressed for the next N results.
   * This is a counter rather than a boolean because a poll may already be in the
   * channel when a user message arrives — the poll's result still needs suppressing.
   */
  pendingSyntheticPolls: number;
  /** Timer for periodic background task notification flushing */
  pollTimer: ReturnType<typeof setInterval> | null;
  /** Model that was used to start this session */
  sessionModel: string;
}

/**
 * Interval in ms between synthetic poll messages to flush background task notifications.
 * The CLI subprocess only emits task_notification messages when processing a user turn,
 * so we periodically send a minimal synthetic message to trigger notification flushing.
 */
const BACKGROUND_TASK_POLL_INTERVAL_MS = 5000;

export class ClaudeCodeService {
  private authValidator: AuthValidator;
  private errorHandler: ErrorHandler;
  private builtinCommandHandler: BuiltinCommandHandler;

  // Multi-instance support: Map of conversation ID to active session
  private activeSessions: Map<string, SessionInstance> = new Map();
  private maxConcurrentQueries: number = MAX_CONCURRENT_QUERIES;

  // Bound sender function for DRY IPC communication
  private send: (channel: string, ...args: unknown[]) => boolean;
  // Cached models list (shared across all sessions)
  private cachedModels: ModelInfo[] = [];
  // Cached slash commands (shared across all sessions)
  private cachedSlashCommands: SlashCommandInfo[] = [];
  private configService: ConfigService;
  private notificationService: NotificationService;
  private sessionPermissionCache: SessionPermissionCache;

  constructor(configService: ConfigService, getMainWindow: () => BrowserWindow | null, notificationService: NotificationService) {
    // Create bound sender using the provided window getter
    this.send = createSender(getMainWindow);

    // Store config service reference for model selection
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

    // Builtin command handler is shared (for /help, /clear, etc.)
    this.builtinCommandHandler = new BuiltinCommandHandler({
      getSlashCommands: () => this.cachedSlashCommands,
      // Note: builtin commands need conversationId, handled in sendMessage
      onChunk: () => {}, // Will be overridden per-call
      onDone: () => {},  // Will be overridden per-call
    });

    logger.info('ClaudeCodeService initialized with persistent session support', {
      maxConcurrentQueries: this.maxConcurrentQueries,
    });
  }

  /**
   * Handle action response from renderer (approve/reject)
   * Routes to the correct conversation's permission manager
   */
  handleActionResponse(conversationId: string, response: ActionResponse): void {
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
   * Emit active query count to renderer
   */
  private emitActiveQueryCount(): void {
    this.send(IPC_CHANNELS.CLAUDE_ACTIVE_QUERIES, this.activeSessions.size, this.maxConcurrentQueries);
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
  async sendMessage(conversationId: string, message: string, workingDirectory: string, resumeSessionId?: string): Promise<void> {
    // Check resource limits
    if (this.activeSessions.size >= this.maxConcurrentQueries && !this.activeSessions.has(conversationId)) {
      const errorMsg = `Maximum concurrent conversations (${this.maxConcurrentQueries}) reached. ` +
        `Please wait for another conversation to complete or cancel it.`;
      logger.warn('Resource limit reached', {
        currentCount: this.activeSessions.size,
        maxCount: this.maxConcurrentQueries,
        conversationId,
      });
      this.emitError(conversationId, errorMsg);
      return;
    }

    // Check if this is a built-in command that must be handled locally
    // (SDK doesn't support built-in CLI commands like /help, /clear, etc.)
    if (this.builtinCommandHandler.isBuiltinCommand(message)) {
      const result = this.builtinCommandHandler.handleCommand(message);
      if (result.handled) {
        logger.info('Handled built-in command locally', {
          conversationId,
          command: message.trim().split(' ')[0],
          hasAction: !!result.action,
        });
        if (result.response) {
          this.emitChunk(conversationId, result.response);
        }
        // Emit special action if needed (e.g., clear conversation)
        if (result.action) {
          this.send(IPC_CHANNELS.CLAUDE_COMMAND_ACTION, result.action);
        }
        this.emitDone(conversationId);
        return;
      }
    }

    // Check if this is a slash command (starts with /)
    const isSlashCommand = message.trim().startsWith('/');

    // Check if auth is configured
    if (!(await this.authValidator.hasAuth())) {
      this.emitError(conversationId, 'Not authenticated. Please login with your Claude account or add an API key in Settings.');
      return;
    }

    // Get selected model to apply to the session
    const selectedModel = await this.configService.getSelectedModel();

    // Check for existing persistent session
    const existingSession = this.activeSessions.get(conversationId);
    if (existingSession && !existingSession.inputChannel.isClosed()) {
      // If the model changed, use SDK's setModel() to switch mid-session
      // (no need to kill the session — context is preserved)
      if (selectedModel && existingSession.sessionModel !== selectedModel) {
        try {
          await existingSession.query.setModel(selectedModel);
          existingSession.sessionModel = selectedModel;
          logger.info('Model changed on existing session via setModel()', {
            conversationId,
            oldModel: existingSession.sessionModel || '(default)',
            newModel: selectedModel,
          });
        } catch (error) {
          logger.warn('Failed to setModel on existing session, will start new session', {
            conversationId, error,
          });
          this.cleanupSession(conversationId);
          await this.startNewSession(conversationId, message, workingDirectory, isSlashCommand, resumeSessionId);
          return;
        }
      }
      // Reuse existing session — push message to channel
      await this.sendToExistingSession(existingSession, message, isSlashCommand);
      return;
    }

    // If there's a dead session, clean it up first
    if (existingSession) {
      logger.info('Cleaning up dead session before starting new one', { conversationId });
      this.cleanupSession(conversationId);
    }

    // Create new persistent session
    await this.startNewSession(conversationId, message, workingDirectory, isSlashCommand, resumeSessionId);
  }

  /**
   * Send a message to an existing persistent session.
   */
  private async sendToExistingSession(session: SessionInstance, message: string, isSlashCommand: boolean): Promise<void> {
    const { conversationId, inputChannel, messageHandler } = session;

    logger.info('Sending message to existing persistent session', {
      conversationId,
      messageLength: message.length,
      isSlashCommand,
      sdkSessionId: session.sdkSessionId?.slice(0, 20),
    });

    // Stop background task polling — the real user message will trigger
    // the CLI to flush any pending task notifications naturally
    if (session.pollTimer) {
      this.stopBackgroundTaskPolling(session);
    }

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

    // Push user message to the channel
    const userMessage: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: message },
      parent_tool_use_id: null,
      session_id: session.sdkSessionId,
    };

    inputChannel.push(userMessage);
    logger.info('Pushed user message to persistent session channel', { conversationId });
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
    );

    // Create session ready promise (resolves when we get session_id from init)
    let resolveSessionReady: (() => void) | null = null;
    const sessionReady = new Promise<void>((resolve) => {
      resolveSessionReady = resolve;
    });

    // Create per-conversation message handler
    const messageHandler = new SDKMessageHandler({
      onChunk: (chunk: string) => {
        // Suppress output during synthetic background task polls
        const session = this.activeSessions.get(conversationId);
        if (session && session.pendingSyntheticPolls > 0) return;
        this.emitChunk(conversationId, chunk);
      },
      onSlashCommands: (commands: SlashCommandInfo[]) => {
        this.cachedSlashCommands = commands;
        this.emitSlashCommands(conversationId, commands);
      },
      onTaskNotification: (notification: TaskNotification) => {
        this.trackBackgroundTask(conversationId, notification);
        this.emitTaskNotification(conversationId, notification);
      },
      onUsageUpdate: (usage: SessionUsage) => {
        // Suppress usage updates from synthetic background task polls
        const session = this.activeSessions.get(conversationId);
        if (session && session.pendingSyntheticPolls > 0) return;
        this.emitUsageUpdate(conversationId, usage);
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

      // When a model is explicitly selected, skip resume because the CLI ignores
      // --model during --resume. The user's model choice must take priority.
      const effectiveResumeId = selectedModel ? undefined : resumeSessionId;

      logger.info('Starting new persistent session', {
        conversationId,
        messageLength: message.length,
        workingDirectory,
        isSlashCommand,
        model: selectedModel || '(SDK default)',
        activeSessions: this.activeSessions.size,
        hasResumeSessionId: !!resumeSessionId,
        effectiveResume: !!effectiveResumeId,
        resumeSkippedForModel: !!resumeSessionId && !effectiveResumeId,
      });

      // Set up authentication environment
      const authEnv = await this.authValidator.setupAuthEnv();

      // CRITICAL: Set auth env vars in actual process.env BEFORE calling query()
      Object.entries(authEnv).forEach(([key, value]) => {
        originalEnv[key] = process.env[key];
        process.env[key] = value;
      });

      // Create the async channel for multi-turn input
      const inputChannel = new AsyncChannel<SDKUserMessage>();

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
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(effectiveResumeId ? { resume: effectiveResumeId } : {}),
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
        runningBackgroundTasks: new Map(),
        pendingSyntheticPolls: 0,
        pollTimer: null,
        sessionModel: selectedModel,
      };
      this.activeSessions.set(conversationId, session);
      this.emitActiveQueryCount();

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
      const userMessage: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: message },
        parent_tool_use_id: null,
        session_id: resumeSessionId || '',
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
   * Runs `for await` over the query's async generator. Unlike the old approach
   * where this blocked sendMessage(), this runs as a detached promise.
   *
   * `emitDone` is called after each `result` message (turn completion),
   * not at the end of the loop (which only happens when the session ends).
   *
   * For synthetic poll turns (used to flush background task notifications),
   * the result is handled silently without emitting done to the renderer.
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

        // Safety mechanism: if a synthetic poll triggers real model work
        // (tool_use requiring user permission), immediately un-flag it so the
        // output reaches the renderer instead of being silently suppressed.
        if (session && session.pendingSyntheticPolls > 0) {
          if (this.isSyntheticPollEscalation(sdkMessage)) {
            logger.warn('Synthetic poll triggered real model work — treating as real turn', {
              conversationId,
              messageType: sdkMessage.type,
              pendingPolls: session.pendingSyntheticPolls,
            });
            // Drain all pending polls — this turn is now real
            session.pendingSyntheticPolls = 0;
          }
        }

        await messageHandler.handleMessage(sdkMessage);

        // After each result message, emit done to signal turn completion
        // The session stays alive for subsequent turns and task notifications
        if (sdkMessage.type === 'result') {
          if (session && session.pendingSyntheticPolls > 0) {
            // Synthetic poll turn completed — suppress done, decrement counter
            session.pendingSyntheticPolls--;
            logger.debug('Synthetic poll turn completed', {
              conversationId,
              remainingPolls: session.pendingSyntheticPolls,
              remainingTasks: session.runningBackgroundTasks.size,
            });
            // Reset message handler state so the next turn starts clean
            messageHandler.reset();
          } else {
            // Normal turn — emit done to renderer
            logger.info('Turn completed (result message received), emitting done', {
              conversationId,
              subtype: (sdkMessage as { subtype?: string }).subtype,
            });
            this.emitDone(conversationId);

            // Start polling if there are running background tasks
            if (session && session.runningBackgroundTasks.size > 0 && !session.pollTimer) {
              this.startBackgroundTaskPolling(session);
            }
          }
        }
      }

      // Generator exhausted — session ended (process exited)
      logger.info('Persistent session message loop ended', { conversationId });
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
  private async fetchAndEmitSlashCommandDetails(conversationId: string, queryIterator: Query): Promise<void> {
    try {
      const commands = await queryIterator.supportedCommands();
      const slashCommands = commands.map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
        argumentHint: cmd.argumentHint,
      }));

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
      } else {
        logger.debug('SDK process exited', { conversationId, code, signal });
      }
    });
  }

  /**
   * Handle query errors
   */
  private handleQueryError(conversationId: string, error: Error, messageHandler: SDKMessageHandler): void {
    if (this.errorHandler.isAbortError(error)) {
      logger.info('Request aborted', { conversationId });
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

    logger.error('Failed to send message', { conversationId, error });

    const userMessage = this.errorHandler.getHumanReadableError(errorMessage);
    this.emitError(conversationId, userMessage);
  }

  /**
   * Track a background task notification — add running tasks, remove completed ones.
   *
   * This maintains the session's `runningBackgroundTasks` map so we know when
   * to start/stop polling for task notification flushing.
   */
  private trackBackgroundTask(conversationId: string, notification: TaskNotification): void {
    const session = this.activeSessions.get(conversationId);
    if (!session) return;

    if (notification.status === 'running') {
      session.runningBackgroundTasks.set(notification.taskId, {
        outputFile: notification.outputFile,
        startedAt: Date.now(),
      });
      // Also remove old key if this is a remapping (previousTaskId)
      if (notification.previousTaskId && notification.previousTaskId !== notification.taskId) {
        session.runningBackgroundTasks.delete(notification.previousTaskId);
      }
      logger.info('Tracking running background task', {
        conversationId,
        taskId: notification.taskId,
        previousTaskId: notification.previousTaskId,
        totalRunning: session.runningBackgroundTasks.size,
        allTaskIds: Array.from(session.runningBackgroundTasks.keys()),
      });
    } else {
      // Task completed/failed/stopped — remove from running map
      let deleted = session.runningBackgroundTasks.delete(notification.taskId);
      // Also try to match by previousTaskId (tool_use ID → background task ID remapping)
      if (!deleted && notification.previousTaskId) {
        deleted = session.runningBackgroundTasks.delete(notification.previousTaskId);
      }
      // Fallback: if no match found, remove the oldest running task.
      // This handles cases where the ID remapping from user messages didn't work
      // (e.g., tool_use ID in the map but background task ID in the notification).
      if (!deleted && session.runningBackgroundTasks.size > 0) {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        for (const [key, task] of session.runningBackgroundTasks.entries()) {
          if (task.startedAt < oldestTime) {
            oldestTime = task.startedAt;
            oldestKey = key;
          }
        }
        if (oldestKey) {
          session.runningBackgroundTasks.delete(oldestKey);
          logger.info('Background task resolved via oldest-match fallback', {
            conversationId,
            notificationTaskId: notification.taskId,
            removedTaskId: oldestKey,
          });
        }
      }
      logger.info('Background task resolved', {
        conversationId,
        taskId: notification.taskId,
        status: notification.status,
        directMatch: deleted,
        remainingTasks: session.runningBackgroundTasks.size,
        allTaskIds: Array.from(session.runningBackgroundTasks.keys()),
      });

      // Stop polling if no more running tasks
      if (session.runningBackgroundTasks.size === 0 && session.pollTimer) {
        this.stopBackgroundTaskPolling(session);
      }
    }
  }

  /**
   * Start periodic polling to flush background task notifications from the CLI subprocess.
   *
   * The CLI only emits task_notification messages to stdout when processing a user turn
   * (via its internal `c()` function). Between turns, completed task notifications
   * accumulate in the CLI's internal queue. This polling mechanism periodically sends
   * a minimal synthetic user message (".") to trigger the CLI to flush those notifications.
   *
   * The synthetic turn's output (chunks, result) is suppressed — only task_notification
   * system messages are forwarded to the renderer.
   */
  private startBackgroundTaskPolling(session: SessionInstance): void {
    if (session.pollTimer) return; // Already polling

    const { conversationId } = session;

    logger.info('Starting background task notification polling', {
      conversationId,
      runningTasks: session.runningBackgroundTasks.size,
      intervalMs: BACKGROUND_TASK_POLL_INTERVAL_MS,
    });

    session.pollTimer = setInterval(() => {
      // Verify session is still active and has running tasks
      if (!this.activeSessions.has(conversationId) ||
          session.runningBackgroundTasks.size === 0 ||
          session.inputChannel.isClosed()) {
        this.stopBackgroundTaskPolling(session);
        return;
      }

      // Don't queue too many polls — if previous polls haven't completed yet,
      // more won't help and would just pile up suppressed results
      if (session.pendingSyntheticPolls > 0) {
        logger.debug('Skipping poll tick — pending polls still in channel', {
          conversationId,
          pendingPolls: session.pendingSyntheticPolls,
        });
        return;
      }

      // Wait for session to be ready before polling
      if (!session.sdkSessionId) {
        logger.debug('Skipping poll tick — session not yet initialized', { conversationId });
        return;
      }

      logger.debug('Sending synthetic poll to flush task notifications', {
        conversationId,
        runningTasks: session.runningBackgroundTasks.size,
      });

      // Increment the pending poll counter — the result handler will decrement it
      session.pendingSyntheticPolls++;

      // Push a minimal synthetic message to trigger the CLI's c() function
      const syntheticMessage: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: '.' },
        parent_tool_use_id: null,
        session_id: session.sdkSessionId,
      };

      session.inputChannel.push(syntheticMessage);
    }, BACKGROUND_TASK_POLL_INTERVAL_MS);
  }

  /**
   * Detect if a synthetic poll has triggered real model work that requires
   * user interaction (tool invocation needing permission).
   *
   * The "." poll message always triggers a model response (the LLM treats it
   * as a user message and generates text). Text responses are expected noise
   * and must stay suppressed. Only tool_use blocks indicate real work — these
   * require user permission and produce meaningful side effects.
   *
   * We intentionally do NOT escalate on text_delta: the model will always
   * respond to "." with some text, and letting it through would create
   * spurious messages in the chat and trigger false emitDone events.
   */
  private isSyntheticPollEscalation(sdkMessage: SDKMessage): boolean {
    // Only escalate on assistant message with tool_use (requires user permission)
    if (sdkMessage.type === 'assistant') {
      const assistantMsg = sdkMessage as SDKAssistantMessage;
      const content = assistantMsg.message?.content;
      if (content?.some((block: { type: string }) => block.type === 'tool_use')) {
        return true;
      }
    }

    return false;
  }

  /**
   * Stop background task notification polling for a session.
   */
  private stopBackgroundTaskPolling(session: SessionInstance): void {
    if (!session.pollTimer) return;

    clearInterval(session.pollTimer);
    session.pollTimer = null;
    // NOTE: Do NOT reset pendingSyntheticPolls here — polls already in the
    // channel still need their results suppressed. The counter decrements
    // naturally as each poll's result arrives in processMessageLoop.

    logger.info('Stopped background task notification polling', {
      conversationId: session.conversationId,
      remainingTasks: session.runningBackgroundTasks.size,
      pendingPolls: session.pendingSyntheticPolls,
    });
  }

  /**
   * Clean up a persistent session
   */
  private cleanupSession(conversationId: string): void {
    const instance = this.activeSessions.get(conversationId);
    if (!instance) {
      return;
    }

    // Stop background task polling
    this.stopBackgroundTaskPolling(instance);

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

    // Remove from active sessions
    this.activeSessions.delete(conversationId);
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
  ): Promise<void> {
    const instance = this.activeSessions.get(conversationId);
    if (instance) {
      instance.permissionManager.handleActionResponse({
        conversationId,
        actionId,
        approved: true,
        updatedInput,
        alwaysAllow,
        chosenScope,
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
   * Abort a specific conversation's session
   */
  async abort(conversationId: string): Promise<void> {
    const instance = this.activeSessions.get(conversationId);
    if (!instance) {
      logger.debug('No active session to abort', { conversationId });
      return;
    }

    try {
      await instance.query.interrupt();
      logger.info('Session interrupted via SDK', { conversationId });
    } catch (error) {
      logger.debug('Could not interrupt session', { conversationId, error });
    }

    instance.abortController.abort();
    logger.info('Session abort requested', { conversationId });

    // Clear pending permissions
    instance.permissionManager.clearPendingPermissions();

    // Clean up immediately
    this.cleanupSession(conversationId);

    // Emit done to signal abort completion
    this.emitDone(conversationId);
  }

  /**
   * Abort all active sessions (e.g., when app is closing)
   */
  async abortAll(): Promise<void> {
    const conversationIds = Array.from(this.activeSessions.keys());
    logger.info('Aborting all active sessions', { count: conversationIds.length });

    await Promise.all(conversationIds.map(id => this.abort(id)));
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
   * Emit an error to the renderer for a specific conversation
   */
  private emitError(conversationId: string, error: string): void {
    this.send(IPC_CHANNELS.CLAUDE_ERROR, conversationId, error);
    this.notificationService.showError(conversationId, error);
  }

  /**
   * Emit done event to the renderer for a specific conversation
   */
  private emitDone(conversationId: string): void {
    this.send(IPC_CHANNELS.CLAUDE_DONE, conversationId);
    this.notificationService.showQueryComplete(conversationId);
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
   * Get available slash commands
   * Returns cached commands from the last SDK init message
   */
  getSlashCommands(): SlashCommandInfo[] {
    return this.cachedSlashCommands;
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
        this.cachedModels = models.map((m) => ({
          value: m.value,
          displayName: m.displayName,
          description: m.description,
        }));
        logger.info('Fetched models from SDK', { count: this.cachedModels.length });
        return this.cachedModels;
      } catch (error) {
        logger.warn('Failed to fetch models from session', { error });
      }
    }

    return [];
  }

  /**
   * Update cached models from SDK (called after session init)
   */
  private async fetchAndCacheModels(queryIterator: Query): Promise<void> {
    try {
      const models = await queryIterator.supportedModels();
      this.cachedModels = models.map((m) => ({
        value: m.value,
        displayName: m.displayName,
        description: m.description,
      }));
      logger.info('Cached models from SDK', {
        count: this.cachedModels.length,
        models: this.cachedModels.map(m => ({ value: m.value, displayName: m.displayName })),
      });
      this.send(IPC_CHANNELS.CLAUDE_MODEL_CHANGED, this.cachedModels);
    } catch (error) {
      logger.warn('Failed to fetch models for caching', error);
    }
  }
}

export default ClaudeCodeService;
