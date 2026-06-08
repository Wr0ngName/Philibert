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

import type { SlashCommandInfo, TaskNotification, BackgroundTaskStatus, SessionUsage, ToolCaptureData } from '../../../shared/types';
import logger from '../../utils/logger';

import { BUILTIN_COMMANDS } from './BuiltinCommandHandler';

/**
 * Best-effort extraction of an error string from an SDK result message.
 *
 * The SDK exposes errors as `errors: string[]` on SDKResultError (sdk.d.ts:3304).
 * Older builds used a singular `error: string`. Use whichever is populated;
 * join multi-entry arrays so the caller sees the full failure context.
 */
export function resolveResultError(
  result: { error?: string; errors?: string[] },
): string {
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    return result.errors.filter((s) => typeof s === 'string').join('; ');
  }
  if (typeof result.error === 'string') return result.error;
  return '';
}

/**
 * Callbacks for emitting events to the renderer
 */
export interface MessageHandlerCallbacks {
  onChunk: (chunk: string) => void;
  onSlashCommands: (commands: SlashCommandInfo[]) => void;
  onTaskNotification: (notification: TaskNotification) => void;
  onUsageUpdate: (usage: SessionUsage) => void;
  onSystemNote: (note: string) => void;
  onToolUseCapture?: (capture: ToolCaptureData) => void;
  onToolResult?: (result: { toolUseBlockId: string; content: string }) => void;
  onSessionId?: (sessionId: string) => void;
  onAuthError?: () => void;
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
    // SDK sets parent_tool_use_id on messages emitted from a sub-agent.
    // Forward it on tool captures so the renderer can group sub-agent activity
    // under the Agent/Task tool that spawned them.
    const parentToolUseId = message.parent_tool_use_id ?? undefined;

    // Log message content for debugging
    logger.debug('Assistant message content', {
      blockCount: content.length,
      blockTypes: content.map(b => b.type),
      isSlashCommandResponse: this.lastMessageWasSlashCommand,
      parentToolUseId,
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
        const lowerText = block.text.toLowerCase();
        const textPreview = block.text.slice(0, 200);
        const isAuthError = lowerText.includes('401') ||
          lowerText.includes('unauthorized') ||
          lowerText.includes('invalid bearer') ||
          lowerText.includes('invalid token');
        if (isAuthError) {
          logger.warn('Assistant message contains auth error keywords', { textPreview });
          this.callbacks.onAuthError?.();
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

        this.callbacks.onToolUseCapture?.({
          toolUseBlockId: toolBlock.id,
          toolName: toolBlock.name,
          input,
          description: this.generateToolDescription(toolBlock.name, input),
          ...(parentToolUseId && { parentToolUseId }),
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

    // Extract tool result content for the detail view
    const msgContent = userMsg.message?.content;
    if (Array.isArray(msgContent)) {
      for (const block of msgContent) {
        if (block.tool_use_id && block.type === 'tool_result') {
          const resultBlock = block as { tool_use_id: string; content?: unknown };
          const content = typeof resultBlock.content === 'string'
            ? resultBlock.content
            : Array.isArray(resultBlock.content)
              ? (resultBlock.content as Array<{ text?: string }>).map(b => b.text || '').join('')
              : JSON.stringify(resultBlock.content);
          this.callbacks.onToolResult?.({
            toolUseBlockId: block.tool_use_id,
            content,
          });
        }
      }
    }

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
      /**
       * Per sdk.d.ts:3304 (SDKResultError) the SDK exposes this as `errors: string[]`.
       * We keep `error` as a defensive read for older SDKs, but `errors[]` is the
       * canonical source — see resolvedError() below.
       */
      error?: string;
      errors?: string[];
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

    const errorText = resolveResultError(resultMessage);

    // Log full result details for debugging
    logger.info('SDK result message', {
      subtype: resultMessage.subtype,
      numTurns: resultMessage.num_turns,
      duration: resultMessage.duration_ms,
      hasResult: !!resultMessage.result,
      resultPreview: resultMessage.result?.slice(0, 200),
      error: errorText,
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
      logger.warn('Query ended with non-success', { subtype: message.subtype, error: errorText });
      const resultError = errorText.toLowerCase();
      if (resultError.includes('401') ||
          resultError.includes('unauthorized') ||
          resultError.includes('invalid bearer') ||
          resultError.includes('invalid token')) {
        this.callbacks.onAuthError?.();
      }
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
   * Process system messages (init, status, task lifecycle, etc.)
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
      // session_state_changed fields
      state?: 'idle' | 'running' | 'requires_action';
      // task_updated fields
      patch?: {
        status?: 'pending' | 'running' | 'completed' | 'failed' | 'killed';
        description?: string;
        error?: string;
        is_backgrounded?: boolean;
      };
      // task_progress fields
      last_tool_name?: string;
      // task_started fields
      task_type?: string;
      skip_transcript?: boolean;
      // Present on task_started / task_notification / task_progress when the task
      // was spawned by a tool_use (e.g. Task/Agent tool). Links the task back to
      // its tool_use indicator so the renderer can dedupe.
      tool_use_id?: string;
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

    // Handle status messages — emit as system notes (rendered as separators,
    // not inline text). Skip transient statuses like "requesting" which get
    // superseded by streaming content.
    if (systemMsg.subtype === 'status' && systemMsg.status && systemMsg.status !== 'requesting') {
      this.callbacks.onSystemNote(systemMsg.status);
    }

    // Handle task notifications (background tasks/agents)
    // SDK sends task_notification when a background task completes/fails/stops
    if (systemMsg.subtype === 'task_notification' && systemMsg.task_id) {
      logger.info('Task notification received', {
        taskId: systemMsg.task_id,
        toolUseId: systemMsg.tool_use_id,
        status: systemMsg.status,
        description: systemMsg.description,
        summary: systemMsg.summary,
        error: systemMsg.error,
        outputFile: systemMsg.output_file,
      });

      const statusMap: Record<string, BackgroundTaskStatus> = {
        'running': 'running',
        'completed': 'completed',
        'failed': 'failed',
        'stopped': 'stopped',
      };

      this.callbacks.onTaskNotification({
        taskId: systemMsg.task_id,
        status: statusMap[systemMsg.status || 'completed'] || 'completed',
        description: systemMsg.description,
        summary: systemMsg.summary,
        outputFile: systemMsg.output_file,
        sessionId: systemMsg.session_id,
        error: systemMsg.error,
        uuid: systemMsg.uuid,
        ...(systemMsg.tool_use_id && { toolUseId: systemMsg.tool_use_id }),
      });
    }

    // Handle task_started — authoritative task start signal from SDK stream
    if (systemMsg.subtype === 'task_started' && systemMsg.task_id) {
      logger.info('Task started', {
        taskId: systemMsg.task_id,
        toolUseId: systemMsg.tool_use_id,
        description: systemMsg.description,
        taskType: systemMsg.task_type,
        skipTranscript: systemMsg.skip_transcript,
      });
      if (!systemMsg.skip_transcript) {
        this.callbacks.onTaskNotification({
          taskId: systemMsg.task_id,
          status: 'running',
          description: systemMsg.description,
          ...(systemMsg.tool_use_id && { toolUseId: systemMsg.tool_use_id }),
        });
      }
    }

    // Handle task_progress — live progress updates (description, AI summary when agentProgressSummaries enabled)
    if (systemMsg.subtype === 'task_progress' && systemMsg.task_id) {
      logger.debug('Task progress', {
        taskId: systemMsg.task_id,
        toolUseId: systemMsg.tool_use_id,
        description: systemMsg.description,
        summary: systemMsg.summary,
        lastToolName: systemMsg.last_tool_name,
      });
      this.callbacks.onTaskNotification({
        taskId: systemMsg.task_id,
        status: 'running',
        description: systemMsg.description,
        summary: systemMsg.summary,
        ...(systemMsg.tool_use_id && { toolUseId: systemMsg.tool_use_id }),
      });
    }

    // Handle task_updated — patch-style status changes
    if (systemMsg.subtype === 'task_updated' && systemMsg.task_id && systemMsg.patch) {
      const patch = systemMsg.patch;
      logger.info('Task updated', { taskId: systemMsg.task_id, patch });
      const statusMap: Record<string, BackgroundTaskStatus> = {
        'running': 'running',
        'completed': 'completed',
        'failed': 'failed',
        'killed': 'stopped',
      };
      if (patch.status && statusMap[patch.status]) {
        this.callbacks.onTaskNotification({
          taskId: systemMsg.task_id,
          status: statusMap[patch.status],
          ...(patch.description && { description: patch.description }),
          ...(patch.error && { error: patch.error }),
        });
      }
    }

    // Handle session_state_changed — authoritative turn-over signal
    if (systemMsg.subtype === 'session_state_changed') {
      logger.info('Session state changed', { state: systemMsg.state });
    }

    // Emit other system messages as system notes
    if (systemMsg.message) {
      this.callbacks.onSystemNote(systemMsg.message);
    }
  }

  private generateToolDescription(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case 'Bash': return `Run: ${((input.command as string) || '').slice(0, 80)}`;
      case 'Read': return `Read: ${input.file_path}`;
      case 'Edit': return `Edit: ${input.file_path}`;
      case 'Write': return `Write: ${input.file_path}`;
      case 'Glob': return `Search files: ${input.pattern}`;
      case 'Grep': return `Search: ${input.pattern}`;
      case 'Agent': return `Agent: ${((input.prompt as string) || '').slice(0, 80)}`;
      default: return `Tool: ${toolName}`;
    }
  }
}

export default SDKMessageHandler;
