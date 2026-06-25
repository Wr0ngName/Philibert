/**
 * Chat store - manages chat messages and Claude interactions
 * Refactored for multi-conversation support with per-conversation state
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

import type { ChatMessage, PendingAction, BackgroundTask, BackgroundTaskStatus, TaskNotification, SessionPermissionEntry, SessionUsage, ModelUsageInfo, ToolCaptureData, ToolUseInfo } from '@shared/types';

import { CONSTANTS } from '../constants/app';
import { generateId, ID_PREFIXES } from '../utils/id';

/**
 * Per-conversation state tracked for multi-instance support
 */
export interface ConversationState {
  /** Whether this conversation has an active query */
  isLoading: boolean;
  /** Current streaming content for this conversation */
  currentStreamingContent: string;
  /** Message ID being streamed in this conversation */
  streamingMessageId: string | null;
  /** Pending actions waiting for user approval */
  pendingActions: PendingAction[];
  /** Background tasks for this conversation */
  backgroundTasks: Map<string, BackgroundTask>;
  /** Session usage (token counts, cost) */
  sessionUsage: SessionUsage | null;
  /** Error message if any */
  error: string | null;
  /** Active session permissions for this conversation */
  sessionPermissions: SessionPermissionEntry[];
  /** File paths modified in the last query (cleared on new query) */
  modifiedFilesInLastQuery: Set<string>;
}

/**
 * Create a fresh conversation state object
 */
function createConversationState(): ConversationState {
  return {
    isLoading: false,
    currentStreamingContent: '',
    streamingMessageId: null,
    pendingActions: [],
    backgroundTasks: new Map(),
    sessionUsage: null,
    error: null,
    sessionPermissions: [],
    modifiedFilesInLastQuery: new Set(),
  };
}

export const useChatStore = defineStore('chat', () => {
  // ============================================
  // Current View State (what user is looking at)
  // ============================================

  /** Messages currently displayed (from active conversation) */
  const messages = ref<ChatMessage[]>([]);

  /** Currently active conversation ID */
  const currentConversationId = ref<string | null>(null);

  // ============================================
  // Per-Conversation State Map
  // ============================================

  /** Map of conversation ID to its state */
  const conversationStates = ref<Map<string, ConversationState>>(new Map());

  // ============================================
  // Global Resource Tracking
  // ============================================

  /** Current number of active sessions (persistent SDK connections) */
  const activeQueryCount = ref(0);

  /** Maximum concurrent queries allowed */
  const maxConcurrentQueries = ref(5);

  /** Number of conversations currently processing a query */
  const processingQueryCount = ref(0);

  /** IDs of conversations with active queries */
  const activeConversationIds = ref<string[]>([]);

  /**
   * Pending scroll-to-message request set by the search modal. ChatWindow
   * watches this, calls scrollToMessage on the MessageList ref, then clears
   * it. Stored at chat-store level (not per-conversation) because the target
   * conversation may not be loaded yet when the request is set.
   */
  const pendingScrollMessageId = ref<string | null>(null);

  // ============================================
  // Helper Functions
  // ============================================

  /**
   * Get or create state for a conversation
   */
  function getConversationState(conversationId: string): ConversationState {
    let state = conversationStates.value.get(conversationId);
    if (!state) {
      state = createConversationState();
      conversationStates.value.set(conversationId, state);
    }
    return state;
  }

  /**
   * Get the current conversation's state
   */
  function getCurrentState(): ConversationState | null {
    if (!currentConversationId.value) return null;
    return getConversationState(currentConversationId.value);
  }

  // ============================================
  // Computed Properties (based on current conversation)
  // ============================================

  const hasMessages = computed(() => messages.value.length > 0);

  const lastMessage = computed(() =>
    messages.value.length > 0 ? messages.value[messages.value.length - 1] : null
  );

  // Current conversation's loading state
  const isLoading = computed(() => {
    const state = getCurrentState();
    return state?.isLoading ?? false;
  });

  // Current conversation's error
  const error = computed(() => {
    const state = getCurrentState();
    return state?.error ?? null;
  });

  // Current conversation's streaming content
  const currentStreamingContent = computed(() => {
    const state = getCurrentState();
    return state?.currentStreamingContent ?? '';
  });

  // Current conversation's pending actions
  const pendingActions = computed(() => {
    const state = getCurrentState();
    return state?.pendingActions ?? [];
  });

  const hasPendingActions = computed(() => pendingActions.value.length > 0);

  // Current conversation's background tasks
  const backgroundTasks = computed(() => {
    const state = getCurrentState();
    return state?.backgroundTasks ?? new Map();
  });

  const hasBackgroundTasks = computed(() => backgroundTasks.value.size > 0);

  const runningTasksCount = computed(() =>
    Array.from(backgroundTasks.value.values()).filter(t => t.status === 'running').length
  );

  const backgroundTasksList = computed(() => Array.from(backgroundTasks.value.values()));

  const runningBackgroundTasksList = computed(() =>
    Array.from(backgroundTasks.value.values()).filter(t => t.status === 'running')
  );

  const hasRunningBackgroundTasks = computed(() => runningBackgroundTasksList.value.length > 0);

  // Current conversation's session usage
  const sessionUsage = computed(() => {
    const state = getCurrentState();
    return state?.sessionUsage ?? null;
  });

  const hasSessionUsage = computed(() => sessionUsage.value !== null);

  const totalTokensUsed = computed(() => {
    if (!sessionUsage.value) return 0;
    if (sessionUsage.value.contextTokens != null) return sessionUsage.value.contextTokens;
    return sessionUsage.value.usage.inputTokens + sessionUsage.value.usage.cacheReadInputTokens + sessionUsage.value.usage.outputTokens;
  });

  const contextWindowSize = computed(() => {
    if (sessionUsage.value?.contextMaxTokens) return sessionUsage.value.contextMaxTokens;
    if (!sessionUsage.value?.modelUsage) return 0;
    const models: ModelUsageInfo[] = Object.values(sessionUsage.value.modelUsage);
    return models.length > 0 ? models[models.length - 1].contextWindow : 0;
  });

  const contextUsagePercent = computed(() => {
    if (contextWindowSize.value === 0) return 0;
    return Math.min(100, (totalTokensUsed.value / contextWindowSize.value) * 100);
  });

  // Resource limit computed
  const isAtResourceLimit = computed(() =>
    activeQueryCount.value >= maxConcurrentQueries.value
  );

  const canStartNewQuery = computed(() =>
    activeQueryCount.value < maxConcurrentQueries.value
  );

  // Current conversation's session permissions
  const sessionPermissions = computed(() => {
    const state = getCurrentState();
    return state?.sessionPermissions ?? [];
  });

  const hasSessionPermissions = computed(() => sessionPermissions.value.length > 0);

  const sessionPermissionCount = computed(() => sessionPermissions.value.length);

  // Modified files tracking
  const modifiedFilesInLastQuery = computed(() => {
    const state = getCurrentState();
    return state?.modifiedFilesInLastQuery ?? new Set<string>();
  });

  // ============================================
  // Current Conversation Management
  // ============================================

  /**
   * Set the currently active conversation
   */
  function setCurrentConversation(conversationId: string | null): void {
    currentConversationId.value = conversationId;
  }

  /**
   * Check if a specific conversation is currently loading
   */
  function isConversationLoading(conversationId: string): boolean {
    const state = conversationStates.value.get(conversationId);
    return state?.isLoading ?? false;
  }

  /**
   * Check if a specific conversation has pending actions
   */
  function conversationHasPendingActions(conversationId: string): boolean {
    const state = conversationStates.value.get(conversationId);
    return (state?.pendingActions.length ?? 0) > 0;
  }

  // ============================================
  // Message Actions
  // ============================================

  function addMessage(message: ChatMessage): void {
    messages.value.push(message);

    // Enforce message limit
    if (messages.value.length > CONSTANTS.MESSAGES.MAX_COUNT) {
      const removeCount = messages.value.length - CONSTANTS.MESSAGES.MAX_COUNT;
      messages.value.splice(0, removeCount);
    }
  }

  function addUserMessage(content: string): ChatMessage {
    const message: ChatMessage = {
      id: generateId(ID_PREFIXES.MESSAGE),
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    addMessage(message);
    return message;
  }

  function addSystemMessage(content: string): ChatMessage {
    const message: ChatMessage = {
      id: generateId(ID_PREFIXES.MESSAGE),
      role: 'system',
      content,
      timestamp: Date.now(),
    };
    addMessage(message);
    return message;
  }

  function startAssistantMessage(conversationId: string): ChatMessage {
    const message: ChatMessage = {
      id: generateId(ID_PREFIXES.MESSAGE),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };

    // Only add to messages array if this is the current conversation
    if (conversationId === currentConversationId.value) {
      addMessage(message);
    }

    // Track streaming state for this conversation
    const state = getConversationState(conversationId);
    state.currentStreamingContent = '';
    state.streamingMessageId = message.id;

    return message;
  }

  /**
   * Append chunk to a conversation's streaming message.
   *
   * If no streaming message exists yet (e.g., a synthetic poll escalated into
   * real model output), a new assistant message is auto-created so the text
   * reaches the user instead of being silently dropped.
   */
  function appendChunk(conversationId: string, chunk: string): void {
    const state = getConversationState(conversationId);

    // Auto-start a streaming assistant message if chunks arrive without one.
    // This handles the case where a background task poll triggers real model work.
    if (!state.streamingMessageId) {
      startAssistantMessage(conversationId);
    }

    state.currentStreamingContent += chunk;

    // If this is the current conversation, also update the message in view
    if (conversationId === currentConversationId.value && state.streamingMessageId) {
      // Search from end for the streaming message — it may not be the very last
      // message because background task or tool use messages can be appended after it.
      for (let i = messages.value.length - 1; i >= 0; i--) {
        const msg = messages.value[i];
        if (msg.id === state.streamingMessageId) {
          msg.content += chunk;
          break;
        }
      }
    }
  }

  /**
   * Get accumulated streaming content for a conversation
   * (used when switching back to a conversation that was streaming)
   */
  function getStreamingContent(conversationId: string): string {
    const state = conversationStates.value.get(conversationId);
    return state?.currentStreamingContent ?? '';
  }

  /**
   * Finish streaming for a conversation
   */
  function finishStreaming(conversationId: string): void {
    const state = conversationStates.value.get(conversationId);
    if (!state) return;

    // If this is the current conversation, find and update the streaming message.
    // We search by ID rather than checking only the last message because background
    // task or tool use messages may have been appended after the streaming message.
    if (conversationId === currentConversationId.value && state.streamingMessageId) {
      for (let i = messages.value.length - 1; i >= 0; i--) {
        const msg = messages.value[i];
        if (msg.id === state.streamingMessageId) {
          msg.isStreaming = false;
          // Ensure content is synced
          msg.content = state.currentStreamingContent;
          break;
        }
      }
    }

    state.streamingMessageId = null;
    state.currentStreamingContent = '';
  }

  function clearMessages(): void {
    messages.value = [];
    // Don't clear conversation state here - that's separate
  }

  function loadMessages(loadedMessages: ChatMessage[]): void {
    messages.value = loadedMessages;
  }

  // ============================================
  // Loading State Actions
  // ============================================

  function setLoading(conversationId: string, loading: boolean): void {
    const state = getConversationState(conversationId);
    state.isLoading = loading;
  }

  // ============================================
  // Error Actions
  // ============================================

  function setError(conversationId: string, errorMessage: string | null): void {
    const state = getConversationState(conversationId);
    state.error = errorMessage;
  }

  function clearError(): void {
    if (currentConversationId.value) {
      const state = getConversationState(currentConversationId.value);
      state.error = null;
    }
  }

  // ============================================
  // Pending Action Actions
  // ============================================

  function addPendingAction(conversationId: string, action: PendingAction): void {
    const state = getConversationState(conversationId);
    state.pendingActions.push(action);
  }

  /**
   * Finalize the current streaming message so that subsequent text chunks
   * create a new message AFTER any tool/task messages inserted in between.
   * This preserves the correct interleaved ordering of text and tool uses.
   */
  function splitStreamingForTool(conversationId: string): void {
    const state = conversationStates.value.get(conversationId);
    if (!state?.streamingMessageId) return;

    if (conversationId === currentConversationId.value) {
      for (let i = messages.value.length - 1; i >= 0; i--) {
        const msg = messages.value[i];
        if (msg.id === state.streamingMessageId) {
          if (msg.content.trim()) {
            msg.isStreaming = false;
          } else {
            messages.value.splice(i, 1);
          }
          break;
        }
      }
    }

    state.streamingMessageId = null;
    state.currentStreamingContent = '';
  }

  /**
   * Insert an inline tool use message into the message stream.
   * Shows the user what tool Claude is invoking, interleaved with text.
   */
  function addToolUseMessage(conversationId: string, action: PendingAction): void {
    if (conversationId !== currentConversationId.value) return;

    splitStreamingForTool(conversationId);

    const message: ChatMessage = {
      id: generateId(ID_PREFIXES.MESSAGE),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolUse: {
        actionId: action.id,
        toolName: action.toolName,
        description: action.description,
        status: 'pending',
        input: action.input,
      },
    };
    addMessage(message);
  }

  /**
   * Insert an inline tool use message from a CLAUDE_TOOL_CAPTURE event.
   * These are emitted for ALL tools (including auto-approved ones).
   * Sets toolUseBlockId and input so the detail modal can show them.
   */
  function addAutoToolUseMessage(conversationId: string, capture: ToolCaptureData): void {
    if (conversationId !== currentConversationId.value) return;

    splitStreamingForTool(conversationId);

    const message: ChatMessage = {
      id: generateId(ID_PREFIXES.MESSAGE),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolUse: {
        actionId: capture.toolUseBlockId,
        toolName: capture.toolName,
        description: capture.description,
        status: 'approved',
        toolUseBlockId: capture.toolUseBlockId,
        input: capture.input,
        ...(capture.parentToolUseId && { parentToolUseId: capture.parentToolUseId }),
      },
    };
    addMessage(message);

    // Dedupe: if a backgroundTask inline message already exists for this
    // tool_use (e.g. task_started arrived before the assistant message
    // carrying the tool_use block), remove it — the tool_use indicator now
    // represents that task in the chat.
    removeBackgroundTaskMessageByToolUseId(capture.toolUseBlockId);
  }

  /**
   * Remove an inline backgroundTask message whose underlying task is tied
   * to the given tool_use ID. Background task still tracked in the Map.
   */
  function removeBackgroundTaskMessageByToolUseId(toolUseId: string): void {
    const state = getCurrentState();
    if (!state) return;

    let linkedTaskId: string | null = null;
    for (const [id, task] of state.backgroundTasks.entries()) {
      if (task.toolUseId === toolUseId) {
        linkedTaskId = id;
        break;
      }
    }
    if (!linkedTaskId) return;

    for (let i = messages.value.length - 1; i >= 0; i--) {
      const msg = messages.value[i];
      if (msg.backgroundTask?.taskId === linkedTaskId) {
        messages.value.splice(i, 1);
        return;
      }
    }
  }

  /**
   * Enrich an existing capture-created ToolUseMessage with the real actionId
   * from a permission prompt. Falls back to creating a new message if no capture match.
   */
  function enrichToolUseFromPermission(conversationId: string, action: PendingAction): void {
    if (conversationId !== currentConversationId.value) return;

    const inputJson = JSON.stringify(action.input);
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const msg = messages.value[i];
      if (
        msg.toolUse &&
        msg.toolUse.toolUseBlockId &&
        msg.toolUse.actionId === msg.toolUse.toolUseBlockId &&
        msg.toolUse.toolName === action.toolName &&
        JSON.stringify(msg.toolUse.input) === inputJson
      ) {
        msg.toolUse = {
          ...msg.toolUse,
          actionId: action.id,
          status: 'pending',
        };
        return;
      }
    }

    // No capture match found — create a new message (fallback)
    addToolUseMessage(conversationId, action);
  }

  /**
   * Set the outputFile on a ToolUseMessage matched by toolUseBlockId.
   * Also marks auto-approved tools as executed.
   */
  function updateToolUseResult(conversationId: string, toolUseBlockId: string, outputFile: string): void {
    if (conversationId !== currentConversationId.value) return;

    for (let i = messages.value.length - 1; i >= 0; i--) {
      const msg = messages.value[i];
      if (msg.toolUse?.toolUseBlockId === toolUseBlockId) {
        const newStatus: ToolUseInfo['status'] =
          msg.toolUse.status === 'approved' ? 'executed' : msg.toolUse.status;
        msg.toolUse = {
          ...msg.toolUse,
          outputFile,
          status: newStatus,
        };
        return;
      }
    }
  }

  /**
   * Update the status of an inline tool use message.
   */
  function updateToolUseStatus(
    conversationId: string,
    actionId: string,
    status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed',
  ): void {
    if (conversationId !== currentConversationId.value) return;

    const msg = messages.value.find((m) => m.toolUse?.actionId === actionId);
    if (msg?.toolUse) {
      msg.toolUse.status = status;
    }
  }

  function removePendingAction(conversationId: string, actionId: string): void {
    const state = conversationStates.value.get(conversationId);
    if (!state) return;

    const index = state.pendingActions.findIndex((a: PendingAction) => a.id === actionId);
    if (index !== -1) {
      state.pendingActions.splice(index, 1);
    }
  }

  function updateActionStatus(conversationId: string, actionId: string, status: PendingAction['status']): void {
    const state = conversationStates.value.get(conversationId);
    if (!state) return;

    const action = state.pendingActions.find((a: PendingAction) => a.id === actionId);
    if (action) {
      action.status = status;
    }
  }

  // ============================================
  // Background Task Actions
  // ============================================

  function handleTaskNotification(conversationId: string, notification: TaskNotification): void {
    const state = getConversationState(conversationId);
    let existingTask = state.backgroundTasks.get(notification.taskId);
    let existingTaskId = notification.taskId;

    // Check for explicit ID remapping (tool_use ID → background task ID)
    if (!existingTask && notification.previousTaskId) {
      existingTask = state.backgroundTasks.get(notification.previousTaskId);
      if (existingTask) {
        existingTaskId = notification.previousTaskId;
      }
    }

    // Implicit remap via toolUseId. task_started carries toolUseId but no
    // previousTaskId, and arrives BEFORE the user-message-based remap. Without
    // this, the initial entry keyed by the toolUseId would be orphaned in the
    // Map and stay "running" forever, while updates target the new SDK task_id.
    if (!existingTask && notification.toolUseId) {
      existingTask = state.backgroundTasks.get(notification.toolUseId);
      if (existingTask) {
        existingTaskId = notification.toolUseId;
      }
    }

    // If no direct match, try to match a running task by description.
    // This handles the case where task_started used the tool_use_id but
    // task_notification uses a different SDK-generated task_id.
    if (!existingTask && notification.status !== 'running' && notification.description) {
      for (const [id, task] of state.backgroundTasks.entries()) {
        if (task.status === 'running' && task.description === notification.description) {
          existingTask = task;
          existingTaskId = id;
          break;
        }
      }
    }

    // Fallback: if no match found and this is a completion notification,
    // match against the oldest running task. This handles cases where the
    // tool_use ID → background task ID remapping didn't propagate to the renderer.
    if (!existingTask && notification.status !== 'running') {
      let oldestEntry: [string, BackgroundTask] | null = null;
      for (const entry of state.backgroundTasks.entries()) {
        if (entry[1].status === 'running') {
          if (!oldestEntry || entry[1].startedAt < oldestEntry[1].startedAt) {
            oldestEntry = entry;
          }
        }
      }
      if (oldestEntry) {
        existingTask = oldestEntry[1];
        existingTaskId = oldestEntry[0];
      }
    }

    if (existingTask) {
      // Replace the Map entry (not just mutate) so Vue's reactivity detects the change.
      // Always update `id` to match the canonical notification.taskId so that
      // task.id stays in sync with the Map key (needed for detail modal lookup).
      const updatedTask: BackgroundTask = {
        ...existingTask,
        id: notification.taskId,
        status: notification.status,
        ...(notification.description && { description: notification.description }),
        ...(notification.summary && { summary: notification.summary }),
        ...(notification.error && { error: notification.error }),
        ...(notification.outputFile && { outputFile: notification.outputFile }),
        ...(notification.status !== 'running' && { completedAt: Date.now() }),
      };

      // Remove old key and set with the notification's task_id (canonical)
      if (existingTaskId !== notification.taskId) {
        state.backgroundTasks.delete(existingTaskId);
      }
      state.backgroundTasks.set(notification.taskId, updatedTask);

      // Update inline chat message (search by old id, remap to new id if changed)
      updateBackgroundTaskMessage(
        conversationId,
        existingTaskId,
        notification.status,
        notification.summary,
        notification.error,
        existingTaskId !== notification.taskId ? notification.taskId : undefined,
      );
    } else {
      const task: BackgroundTask = {
        id: notification.taskId,
        description: notification.description || 'Background task',
        status: notification.status,
        startedAt: Date.now(),
        summary: notification.summary,
        outputFile: notification.outputFile,
        sessionId: notification.sessionId,
        error: notification.error,
        ...(notification.toolUseId && { toolUseId: notification.toolUseId }),
      };
      if (notification.status !== 'running') {
        task.completedAt = Date.now();
      }
      state.backgroundTasks.set(notification.taskId, task);

      // Dedupe: a task spawned by a tool_use (Task/Agent) is already
      // represented inline by its tool_use indicator. Only add an inline
      // backgroundTask entry when there's no matching tool_use yet — or no
      // tool_use link at all (true background commands).
      if (notification.toolUseId && hasToolUseMessage(conversationId, notification.toolUseId)) {
        return;
      }
      addBackgroundTaskMessage(conversationId, task);
    }
  }

  /**
   * Whether the message stream already contains a tool_use indicator with
   * the given SDK tool_use block ID.
   */
  function hasToolUseMessage(conversationId: string, toolUseBlockId: string): boolean {
    if (conversationId !== currentConversationId.value) return false;
    for (const m of messages.value) {
      if (m.toolUse?.toolUseBlockId === toolUseBlockId) return true;
    }
    return false;
  }

  /**
   * Insert an inline background task message into the message stream.
   */
  function addBackgroundTaskMessage(conversationId: string, task: BackgroundTask): void {
    if (conversationId !== currentConversationId.value) return;

    const message: ChatMessage = {
      id: generateId(ID_PREFIXES.MESSAGE),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      backgroundTask: {
        taskId: task.id,
        description: task.description,
        status: task.status,
        summary: task.summary,
        error: task.error,
      },
    };
    addMessage(message);
  }

  /**
   * Update the status of an inline background task message.
   * @param newTaskId - If provided, also updates the taskId (for ID remapping)
   */
  function updateBackgroundTaskMessage(
    conversationId: string,
    taskId: string,
    status: BackgroundTaskStatus,
    summary?: string,
    error?: string,
    newTaskId?: string,
  ): void {
    if (conversationId !== currentConversationId.value) return;

    const msg = messages.value.find((m) => m.backgroundTask?.taskId === taskId);
    if (msg?.backgroundTask) {
      // Replace the object (not just mutate) so Vue's reactivity detects the change
      msg.backgroundTask = {
        ...msg.backgroundTask,
        status,
        ...(newTaskId && { taskId: newTaskId }),
        ...(summary && { summary }),
        ...(error && { error }),
      };
    }
  }

  function completeRunningTasks(conversationId: string): void {
    const state = conversationStates.value.get(conversationId);
    if (!state) {
      return;
    }
    const now = Date.now();
    for (const [id, task] of state.backgroundTasks.entries()) {
      if (task.status === 'running') {
        state.backgroundTasks.set(id, { ...task, status: 'completed', completedAt: now });
      }
    }
  }

  /**
   * Mark all in-flight tool use messages as 'executed'.
   * Called when a query completes to ensure no tool use spinners linger.
   */
  function completeToolUseMessages(conversationId: string): void {
    if (conversationId !== currentConversationId.value) return;

    for (const msg of messages.value) {
      if (msg.toolUse && (msg.toolUse.status === 'pending' || msg.toolUse.status === 'approved')) {
        msg.toolUse.status = 'executed';
      }
    }
  }

  function clearAllBackgroundTasks(conversationId?: string): void {
    const targetId = conversationId ?? currentConversationId.value;
    if (targetId) {
      const state = conversationStates.value.get(targetId);
      if (state) {
        state.backgroundTasks.clear();
      }
    }
  }

  // ============================================
  // Session Usage Actions
  // ============================================

  function updateSessionUsage(conversationId: string, usage: SessionUsage): void {
    const state = getConversationState(conversationId);
    state.sessionUsage = usage;
  }

  function clearSessionUsage(conversationId?: string): void {
    const targetId = conversationId ?? currentConversationId.value;
    if (targetId) {
      const state = conversationStates.value.get(targetId);
      if (state) {
        state.sessionUsage = null;
      }
    }
  }

  // ============================================
  // Resource Tracking Actions
  // ============================================

  function updateActiveQueries(count: number, max: number, processingCount: number): void {
    activeQueryCount.value = count;
    maxConcurrentQueries.value = max;
    processingQueryCount.value = processingCount;
  }

  function updateActiveConversationIds(ids: string[]): void {
    activeConversationIds.value = ids;
  }

  // ============================================
  // Session Permission Actions
  // ============================================

  function updateSessionPermissions(conversationId: string, permissions: SessionPermissionEntry[]): void {
    const state = getConversationState(conversationId);
    state.sessionPermissions = permissions;
  }

  // ============================================
  // Modified Files Tracking
  // ============================================

  function trackFileModification(conversationId: string, filePath: string): void {
    const state = getConversationState(conversationId);
    state.modifiedFilesInLastQuery.add(filePath);
  }

  function clearModifiedFiles(conversationId: string): void {
    const state = conversationStates.value.get(conversationId);
    if (state) {
      state.modifiedFilesInLastQuery = new Set();
    }
  }

  // ============================================
  // Cleanup Actions
  // ============================================

  /**
   * Clear all state for a conversation (e.g., when deleted)
   */
  function clearConversationState(conversationId: string): void {
    conversationStates.value.delete(conversationId);
  }

  /**
   * Reset all per-conversation state
   */
  function resetAllConversationStates(): void {
    conversationStates.value.clear();
  }

  // ============================================
  // Legacy compatibility - these methods work on current conversation
  // They delegate to the conversation-specific versions
  // ============================================

  /** @deprecated Use appendChunk(conversationId, chunk) instead */
  function appendToLastMessage(chunk: string): void {
    if (currentConversationId.value) {
      appendChunk(currentConversationId.value, chunk);
    }
  }

  return {
    // Current view state
    messages,
    currentConversationId,

    // Per-conversation state map (for advanced use)
    conversationStates,

    // Resource tracking
    activeQueryCount,
    maxConcurrentQueries,
    processingQueryCount,
    activeConversationIds,

    // Search → scroll plumbing
    pendingScrollMessageId,

    // Computed (based on current conversation)
    hasMessages,
    hasPendingActions,
    lastMessage,
    hasBackgroundTasks,
    runningTasksCount,
    backgroundTasksList,
    runningBackgroundTasksList,
    hasRunningBackgroundTasks,
    hasSessionUsage,
    totalTokensUsed,
    contextWindowSize,
    contextUsagePercent,
    isLoading,
    error,
    currentStreamingContent,
    pendingActions,
    sessionUsage,
    backgroundTasks,
    isAtResourceLimit,
    canStartNewQuery,
    sessionPermissions,
    hasSessionPermissions,
    sessionPermissionCount,

    // Conversation management
    setCurrentConversation,
    isConversationLoading,
    conversationHasPendingActions,
    getConversationState,
    getStreamingContent,

    // Message actions
    addMessage,
    addUserMessage,
    addSystemMessage,
    startAssistantMessage,
    appendChunk,
    appendToLastMessage, // Legacy
    finishStreaming,
    clearMessages,
    loadMessages,

    // Loading state
    setLoading,

    // Error actions
    setError,
    clearError,

    // Pending action actions
    addPendingAction,
    removePendingAction,
    updateActionStatus,
    addToolUseMessage,
    addAutoToolUseMessage,
    enrichToolUseFromPermission,
    updateToolUseResult,
    updateToolUseStatus,

    // Background task actions
    handleTaskNotification,
    addBackgroundTaskMessage,
    updateBackgroundTaskMessage,
    clearAllBackgroundTasks,
    completeRunningTasks,
    completeToolUseMessages,

    // Session usage actions
    updateSessionUsage,
    clearSessionUsage,

    // Resource tracking
    updateActiveQueries,
    updateActiveConversationIds,

    // Session permission actions
    updateSessionPermissions,

    // Modified files tracking
    modifiedFilesInLastQuery,
    trackFileModification,
    clearModifiedFiles,

    // Cleanup
    clearConversationState,
    resetAllConversationStates,
  };
});
