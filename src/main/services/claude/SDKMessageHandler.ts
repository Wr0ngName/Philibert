/**
 * SDK Message Handler for Claude Code
 *
 * Processes messages from the Claude Code SDK and emits events to the renderer.
 * Extracted from ClaudeCodeService for better separation of concerns.
 */

import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';

import type { SlashCommandInfo, TaskNotification, BackgroundTaskStatus, SessionUsage } from '../../../shared/types';
import logger from '../../utils/logger';

import { BUILTIN_COMMANDS } from './BuiltinCommandHandler';

/**
 * Callbacks for emitting events to the renderer
 */
export interface MessageHandlerCallbacks {
  onChunk: (chunk: string) => void;
  onSlashCommands: (commands: SlashCommandInfo[]) => void;
  onTaskNotification: (notification: TaskNotification) => void;
  onUsageUpdate: (usage: SessionUsage) => void;
  onSessionId?: (sessionId: string) => void;
}

/**
 * Result of processing SDK messages
 */
export interface MessageProcessingResult {
  /** Whether the query completed successfully */
  querySucceeded: boolean;
  /** Cached slash commands from init message */
  slashCommands: SlashCommandInfo[];
}

/**
 * Handles messages from the Claude Code SDK
 */
export class SDKMessageHandler {
  private callbacks: MessageHandlerCallbacks;
  private querySucceeded = false;
  // Initialize with built-in commands so they're available immediately at startup
  private cachedSlashCommands: SlashCommandInfo[] = [...BUILTIN_COMMANDS];
  /** Tracks when the last user message was a slash command for output handling */
  private lastMessageWasSlashCommand = false;
  /** Tracks if content was streamed via content_block_delta events */
  private hasStreamedContent = false;
  /** Maps tool_use IDs to background task IDs (from SDK user messages with tool results) */
  private toolUseToTaskId = new Map<string, string>();

  constructor(callbacks: MessageHandlerCallbacks) {
    this.callbacks = callbacks;
    // Emit built-in commands immediately so renderer has them at startup
    this.callbacks.onSlashCommands(this.cachedSlashCommands);
    logger.info('SDKMessageHandler initialized with built-in commands', {
      count: this.cachedSlashCommands.length,
    });
  }

  /**
   * Reset state for a new query
   */
  reset(): void {
    this.querySucceeded = false;
    this.lastMessageWasSlashCommand = false;
    this.hasStreamedContent = false;
  }

  /**
   * Mark that the last message sent was a slash command.
   * Used to handle command output specially since it may come as assistant messages.
   */
  markSlashCommandSent(): void {
    this.lastMessageWasSlashCommand = true;
    logger.debug('Marked last message as slash command');
  }

  /**
   * Update cached slash commands with full details (descriptions, argument hints).
   * Called after fetching details via supportedCommands().
   * Merges SDK skills with built-in CLI commands.
   */
  updateSlashCommands(commands: SlashCommandInfo[]): void {
    // Merge built-in commands with SDK-provided skills
    // SDK skills take precedence if they have the same name (more specific descriptions)
    const commandMap = new Map<string, SlashCommandInfo>();

    // Add built-in commands first
    for (const cmd of BUILTIN_COMMANDS) {
      commandMap.set(cmd.name, cmd);
    }

    // Override/add SDK commands (skills)
    for (const cmd of commands) {
      commandMap.set(cmd.name, cmd);
    }

    this.cachedSlashCommands = Array.from(commandMap.values());
    logger.info('Updated slash commands with full details', {
      count: this.cachedSlashCommands.length,
      builtinCount: BUILTIN_COMMANDS.length,
      sdkCount: commands.length,
    });
  }

  /**
   * Check if the query succeeded
   */
  didQuerySucceed(): boolean {
    return this.querySucceeded;
  }

  /**
   * Get cached slash commands
   */
  getSlashCommands(): SlashCommandInfo[] {
    return this.cachedSlashCommands;
  }

  /**
   * Handle a message from the Claude Code SDK
   */
  async handleMessage(message: SDKMessage): Promise<void> {
    // Log all SDK messages for debugging
    logger.debug('SDK message received', {
      type: message.type,
      subtype: (message as { subtype?: string }).subtype,
      hasContent: !!(message as SDKAssistantMessage).message?.content,
    });

    switch (message.type) {
      case 'assistant':
        await this.processAssistantMessage(message as SDKAssistantMessage);
        break;

      case 'result':
        this.processResultMessage(message as SDKResultMessage);
        break;

      case 'stream_event':
        this.processStreamEvent(message);
        break;

      case 'system':
        this.processSystemMessage(message);
        break;

      case 'user':
        this.processUserMessage(message);
        break;

      default:
        logger.info('Unhandled SDK message type', {
          type: message.type,
          subtype: (message as { subtype?: string }).subtype,
          allKeys: Object.keys(message),
          raw: JSON.stringify(message).slice(0, 500),
        });
    }
  }

  /**
   * Process assistant message and extract text/tool use
   * Note: Text content is streamed via handleStreamEvent's content_block_delta events.
   * We do NOT emit text here because with includePartialMessages:true we get multiple
   * assistant messages (partial and final) which would cause duplication.
   *
   * EXCEPTION: Slash command responses may come as assistant messages without streaming,
   * so we emit those directly when lastMessageWasSlashCommand is true.
   */
  private async processAssistantMessage(message: SDKAssistantMessage): Promise<void> {
    const content = message.message.content;

    // Log message content for debugging
    logger.debug('Assistant message content', {
      blockCount: content.length,
      blockTypes: content.map(b => b.type),
      isSlashCommandResponse: this.lastMessageWasSlashCommand,
    });

    // Special handling for slash command responses
    // These may not stream, so we emit the text directly
    if (this.lastMessageWasSlashCommand) {
      for (const block of content) {
        if (block.type === 'text' && block.text.trim()) {
          logger.debug('Emitting slash command response', {
            textLength: block.text.length,
            preview: block.text.slice(0, 100),
          });
          this.callbacks.onChunk(block.text);
        }
      }
      this.lastMessageWasSlashCommand = false;
      return;
    }

    for (const block of content) {
      if (block.type === 'text') {
        // Log warnings for auth errors (don't emit, just log)
        const textPreview = block.text.slice(0, 200);
        if (block.text.toLowerCase().includes('401') ||
            block.text.toLowerCase().includes('unauthorized') ||
            block.text.toLowerCase().includes('invalid')) {
          logger.warn('Assistant message contains error keywords', { textPreview });
        }
      }

      // Detect background tool launches to emit "running" notifications.
      // Any tool (Bash, Task, etc.) can have run_in_background: true.
      if (block.type === 'tool_use') {
        const toolBlock = block as { type: 'tool_use'; id: string; name: string; input: unknown };
        const input = (toolBlock.input || {}) as Record<string, unknown>;

        logger.info('Tool use block detected', {
          toolUseId: toolBlock.id,
          toolName: toolBlock.name,
          runInBackground: !!input.run_in_background,
          inputKeys: Object.keys(input),
          inputPreview: JSON.stringify(input).slice(0, 200),
        });

        if (input.run_in_background) {
          // Extract description from tool input
          const description = (input.description as string)
            || (input.prompt as string)
            || (input.command as string)
            || `Background ${toolBlock.name}`;
          logger.info('Background tool_use detected', {
            toolUseId: toolBlock.id,
            toolName: toolBlock.name,
            description: description.slice(0, 100),
          });
          this.callbacks.onTaskNotification({
            taskId: toolBlock.id,
            status: 'running',
            description,
          });
        }
      }
    }
  }

  /**
   * Process user messages (tool results) to extract background task IDs.
   *
   * When a tool runs in background, the SDK sends a user message with tool_use_result
   * containing the background task ID and output file. We use this to:
   * 1. Map tool_use IDs to background task IDs (for matching task_notifications later)
   * 2. Update the running task notification with the real task ID
   */
  private processUserMessage(message: SDKMessage): void {
    const userMsg = message as {
      type: 'user';
      message?: { role: string; content?: Array<{ tool_use_id?: string; type?: string; content?: string }> };
      tool_use_result?: {
        stdout?: string;
        stderr?: string;
        interrupted?: boolean;
        /** Background task ID assigned by the CLI when a command runs in background */
        backgroundTaskId?: string;
        /** True if the user manually backgrounded the command (Ctrl+B) */
        backgroundedByUser?: boolean;
      };
    };

    // Extract background task info from tool_use_result.
    // When a tool runs in background, the CLI sets backgroundTaskId on the tool_use_result.
    // We use this to map tool_use IDs (toolu_*) → background task IDs (b*) for
    // proper matching when task_notification messages arrive later.
    const toolResult = userMsg.tool_use_result;
    if (toolResult?.backgroundTaskId) {
      const toolUseId = userMsg.message?.content?.[0]?.tool_use_id;
      const backgroundTaskId = toolResult.backgroundTaskId;

      if (toolUseId) {
        logger.info('Background task ID mapping from user message', {
          toolUseId,
          backgroundTaskId,
        });

        // Store mapping for later task_notification matching
        this.toolUseToTaskId.set(toolUseId, backgroundTaskId);

        // Re-emit running notification with the real background task ID
        // and previousTaskId so renderer can remap the existing entry
        this.callbacks.onTaskNotification({
          taskId: backgroundTaskId,
          status: 'running',
          previousTaskId: toolUseId,
        });
      }
    }
  }

  /**
   * Process result message
   */
  private processResultMessage(message: SDKResultMessage): void {
    // Extract result text and usage data from result message
    // The SDK provides detailed token usage in success and error result messages
    const resultMessage = message as {
      subtype?: string;
      result?: string;
      error?: string;
      num_turns?: number;
      duration_ms?: number;
      total_cost_usd?: number;
      session_id?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      modelUsage?: Record<string, {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
        webSearchRequests?: number;
        costUSD?: number;
        contextWindow?: number;
        maxOutputTokens?: number;
      }>;
    };

    // Log full result details for debugging
    logger.info('SDK result message', {
      subtype: resultMessage.subtype,
      numTurns: resultMessage.num_turns,
      duration: resultMessage.duration_ms,
      hasResult: !!resultMessage.result,
      resultPreview: resultMessage.result?.slice(0, 200),
      error: resultMessage.error,
      totalCostUSD: resultMessage.total_cost_usd,
      hasUsage: !!resultMessage.usage,
    });

    // Extract and emit usage data (available on both success and error results)
    if (resultMessage.usage || resultMessage.modelUsage) {
      const sessionUsage: SessionUsage = {
        totalCostUSD: resultMessage.total_cost_usd || 0,
        usage: {
          inputTokens: resultMessage.usage?.input_tokens || 0,
          outputTokens: resultMessage.usage?.output_tokens || 0,
          cacheReadInputTokens: resultMessage.usage?.cache_read_input_tokens || 0,
          cacheCreationInputTokens: resultMessage.usage?.cache_creation_input_tokens || 0,
        },
        modelUsage: {},
        numTurns: resultMessage.num_turns || 0,
        durationMs: resultMessage.duration_ms || 0,
      };

      // Process per-model usage if available
      if (resultMessage.modelUsage) {
        for (const [modelName, modelData] of Object.entries(resultMessage.modelUsage)) {
          sessionUsage.modelUsage[modelName] = {
            inputTokens: modelData.inputTokens || 0,
            outputTokens: modelData.outputTokens || 0,
            cacheReadInputTokens: modelData.cacheReadInputTokens || 0,
            cacheCreationInputTokens: modelData.cacheCreationInputTokens || 0,
            webSearchRequests: modelData.webSearchRequests || 0,
            costUSD: modelData.costUSD || 0,
            contextWindow: modelData.contextWindow || 0,
            maxOutputTokens: modelData.maxOutputTokens || 0,
          };
        }
      }

      logger.info('Emitting session usage', {
        totalCostUSD: sessionUsage.totalCostUSD,
        inputTokens: sessionUsage.usage.inputTokens,
        outputTokens: sessionUsage.usage.outputTokens,
        modelCount: Object.keys(sessionUsage.modelUsage).length,
      });

      this.callbacks.onUsageUpdate(sessionUsage);
    }

    if (message.subtype === 'success') {
      // Only emit session_id from SUCCESSFUL results — error results (e.g. failed --resume)
      // contain ephemeral session IDs that would create a chain of stale IDs if persisted.
      if (resultMessage.session_id && this.callbacks.onSessionId) {
        this.callbacks.onSessionId(resultMessage.session_id);
      }
      // Mark query as succeeded - used to handle process exit errors gracefully
      this.querySucceeded = true;

      // Only emit result text if content wasn't already streamed.
      // Regular messages stream via content_block_delta events - emitting result would duplicate.
      // Slash commands and other non-streaming responses need the result text emitted here.
      if (!this.hasStreamedContent && resultMessage.result?.trim()) {
        logger.debug('Emitting result text (no streamed content)', {
          resultLength: resultMessage.result.length,
        });
        this.callbacks.onChunk(resultMessage.result);
      }
    } else {
      logger.warn('Query ended with non-success', { subtype: message.subtype });
    }
  }

  /**
   * Process streaming events for real-time text updates
   */
  private processStreamEvent(message: SDKMessage): void {
    const event = (message as { event?: { type?: string; index?: number; content_block?: { type?: string }; delta?: { type?: string; text?: string } } }).event;

    // Emit line break between content blocks for clarity
    // When a new text content_block_start arrives and we already have streamed content,
    // add a visual separator so responses don't run together
    if (event?.type === 'content_block_start' && event?.content_block?.type === 'text' && this.hasStreamedContent) {
      this.callbacks.onChunk('\n\n');
    }

    if (event?.type === 'content_block_delta' && event?.delta?.type === 'text_delta') {
      this.hasStreamedContent = true;
      this.callbacks.onChunk(event.delta.text || '');
    }
  }

  /**
   * Process system messages (init, status, task_notification, etc.)
   *
   * IMPORTANT: The SDK uses snake_case for all message fields.
   * We must use snake_case field names when reading from SDK messages.
   */
  private processSystemMessage(message: SDKMessage): void {
    const systemMsg = message as {
      subtype?: string;
      message?: string;
      slash_commands?: string[];
      tools?: string[];
      model?: string;
      // Used by both 'status' subtype (SDKStatus) and 'task_notification' subtype (task status)
      status?: string;
      // Task notification fields (SDK uses snake_case)
      task_id?: string;
      description?: string;
      summary?: string;
      output_file?: string;
      session_id?: string;
      error?: string;
      uuid?: string;
    };

    // Log ALL system messages at info level for debugging task flow
    logger.info('System message received', {
      subtype: systemMsg.subtype,
      allKeys: Object.keys(message),
      rawPreview: JSON.stringify(message).slice(0, 500),
    });

    // Handle init message - capture available slash commands and session ID
    if (systemMsg.subtype === 'init') {
      logger.info('SDK init received', {
        slashCommandCount: systemMsg.slash_commands?.length || 0,
        slashCommands: systemMsg.slash_commands,
        model: systemMsg.model,
        session_id: systemMsg.session_id,
      });

      // Emit session ID if present (for conversation continuity)
      // SDK uses snake_case: session_id
      if (systemMsg.session_id && this.callbacks.onSessionId) {
        logger.info('SDK session ID received', { session_id: systemMsg.session_id });
        this.callbacks.onSessionId(systemMsg.session_id);
      }

      // Process slash commands if present
      if (systemMsg.slash_commands) {
        // Always merge SDK commands with existing cache (built-in + any previous SDK commands)
        // This preserves descriptions from built-in commands and supportedCommands()
        const commandMap = new Map<string, SlashCommandInfo>();

        // Add existing cached commands first (preserves descriptions)
        for (const cmd of this.cachedSlashCommands) {
          commandMap.set(cmd.name, cmd);
        }

        // Add new SDK commands (only if not already present - preserve existing descriptions)
        for (const name of systemMsg.slash_commands) {
          if (!commandMap.has(name)) {
            commandMap.set(name, { name, description: '', argumentHint: '' });
          }
        }

        this.cachedSlashCommands = Array.from(commandMap.values());
        logger.info('Merged built-in and SDK commands from init', {
          total: this.cachedSlashCommands.length,
          sdkCount: systemMsg.slash_commands.length,
        });
        // Emit slash commands to renderer
        this.callbacks.onSlashCommands(this.cachedSlashCommands);
      }
    }

    // Handle status messages — only emit statuses that represent meaningful
    // progress (e.g. "compacting"). Skip transient statuses like "requesting"
    // which get superseded by streaming content and would pollute the message.
    if (systemMsg.subtype === 'status' && systemMsg.status && systemMsg.status !== 'requesting') {
      this.callbacks.onChunk(`\n_${systemMsg.status}_\n`);
    }

    // Handle task notifications (background tasks/agents)
    // SDK sends task_notification when a background task completes/fails/stops
    // Task *start* is detected from assistant tool_use messages (Task tool), not from system messages
    if (systemMsg.subtype === 'task_notification' && systemMsg.task_id) {
      logger.info('Task notification received', {
        subtype: systemMsg.subtype,
        taskId: systemMsg.task_id,
        status: systemMsg.status,
        description: systemMsg.description,
        summary: systemMsg.summary,
        error: systemMsg.error,
        outputFile: systemMsg.output_file,
        sessionId: systemMsg.session_id,
      });

      // Map SDK status to our BackgroundTaskStatus type
      // SDK only sends: 'completed' | 'failed' | 'stopped' per SDKTaskNotificationMessage
      const statusMap: Record<string, BackgroundTaskStatus> = {
        'running': 'running',
        'completed': 'completed',
        'failed': 'failed',
        'stopped': 'stopped',
      };

      const notification: TaskNotification = {
        taskId: systemMsg.task_id,
        status: statusMap[systemMsg.status || 'completed'] || 'completed',
        description: systemMsg.description,
        summary: systemMsg.summary,
        outputFile: systemMsg.output_file,
        sessionId: systemMsg.session_id,
        error: systemMsg.error,
        uuid: systemMsg.uuid,
      };

      this.callbacks.onTaskNotification(notification);
    }

    // Emit other system messages to the UI
    if (systemMsg.message) {
      this.callbacks.onChunk(`\n_${systemMsg.message}_\n`);
    }
  }
}

export default SDKMessageHandler;
