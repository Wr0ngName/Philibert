/**
 * Composable for Claude chat functionality
 *
 * IMPORTANT: IPC listeners are registered as a singleton to prevent
 * duplicate message processing when multiple components use this composable.
 *
 * Updated for multi-conversation support - all events now include conversationId
 * for proper routing to per-conversation state.
 */

import { onMounted, onUnmounted, shallowRef } from 'vue';

import type { AskUserQuestionAnswer, AskUserQuestionResponse, SlashCommandInfo, ChatMessage, PermissionScope } from '@shared/types';

import { useChatStore } from '../stores/chat';
import { useConversationsStore } from '../stores/conversations';
import { useFilesStore } from '../stores/files';
import { useSettingsStore } from '../stores/settings';
import { logger } from '../utils/logger';

import { useSlashCommands } from './useSlashCommands';

// Singleton state for IPC listeners - shared across all composable instances
// This prevents duplicate listener registration when multiple components use this composable
let listenersRegistered = false;
let listenerRefCount = 0;
let cleanupChunk: (() => void) | null = null;
let cleanupToolUse: (() => void) | null = null;
let cleanupError: (() => void) | null = null;
let cleanupDone: (() => void) | null = null;
let cleanupSlashCommands: (() => void) | null = null;
let cleanupActiveModel: (() => void) | null = null;
let cleanupSubagentActivity: (() => void) | null = null;
let cleanupUserTurnUuid: (() => void) | null = null;
let cleanupTaskNotification: (() => void) | null = null;
let cleanupBackgroundTasksChanged: (() => void) | null = null;
let cleanupUsageUpdate: (() => void) | null = null;
let cleanupActiveQueries: (() => void) | null = null;
let cleanupSessionId: (() => void) | null = null;
let cleanupSessionPermissions: (() => void) | null = null;
let cleanupToolExecuted: (() => void) | null = null;
let cleanupSystemNote: (() => void) | null = null;
let cleanupToolCapture: (() => void) | null = null;
let cleanupToolResult: (() => void) | null = null;
let cleanupAuthInvalidated: (() => void) | null = null;

// Shared slash commands state (singleton)
const sharedSlashCommands = shallowRef<SlashCommandInfo[]>([]);

/**
 * Get in-memory messages for a conversation that may be running in background.
 * Used when switching to a conversation to get the latest messages without
 * waiting for the file to be saved.
 *
 * The buffer lives in the chat store rather than here. It used to be a private
 * map in this module, which meant the store — the only place that knows how to
 * build a tool-use message — could not reach it, so every tool-use function
 * returned early for a conversation that was not on screen and its history
 * came back with no tool uses at all.
 */
export function getInMemoryMessages(conversationId: string): ChatMessage[] | null {
  return useChatStore().getBufferedMessages(conversationId);
}

export function useClaudeChat() {
  const chatStore = useChatStore();
  const conversationsStore = useConversationsStore();
  const filesStore = useFilesStore();
  const settingsStore = useSettingsStore();

  // Reference to shared slash commands
  const slashCommands = sharedSlashCommands;

  // Dispatch for commands the GUI handles itself. The list is passed in so the
  // dispatcher does not import this module back.
  const { handleSlashCommand } = useSlashCommands(slashCommands);

  /**
   * Load available slash commands from the SDK
   */
  async function loadSlashCommands(): Promise<void> {
    try {
      const commands = await window.electron.claude.getCommands();
      // Never assign a non-array into the shared ref. It is module-level state
      // reused by every component instance, so one bad response would make the
      // next mount throw on `.length` and take the whole chat view down.
      slashCommands.value = Array.isArray(commands) ? commands : [];
      logger.debug('Loaded slash commands', { count: slashCommands.value.length });
    } catch (err) {
      logger.warn('Failed to load slash commands', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Load active query status from the main process
   */
  async function loadActiveQueries(): Promise<void> {
    try {
      const status = await window.electron.claude.getActiveQueries();
      chatStore.updateActiveQueries(status.count, status.maxCount, status.processingCount);
      chatStore.updateActiveConversationIds(status.activeConversationIds);
    } catch (err) {
      logger.warn('Failed to load active queries', { error: err });
    }
  }

  /**
   * Send a message to Claude
   */
  async function sendMessage(content: string) {
    if (!content.trim()) {
      return;
    }

    const currentConvId = conversationsStore.currentConversationId;
    if (!currentConvId) {
      chatStore.setError(currentConvId || 'unknown', 'No active conversation');
      return;
    }

    // Check prerequisites
    if (!settingsStore.hasAuth) {
      chatStore.setError(currentConvId, 'Please log in or configure your API key in Settings');
      return;
    }

    if (!filesStore.workingDirectory) {
      chatStore.setError(currentConvId, 'Please select a working directory');
      return;
    }

    // Check resource limits
    if (chatStore.isAtResourceLimit && !chatStore.isConversationLoading(currentConvId)) {
      chatStore.setError(
        currentConvId,
        `Maximum concurrent runs (${chatStore.maxConcurrentQueries}) reached. ` +
        `Please wait for another conversation's current turn to finish or cancel it.`
      );
      return;
    }

    // Clear any previous error and modified files from last query
    chatStore.clearError();
    chatStore.clearModifiedFiles(currentConvId);

    // Add user message to chat
    chatStore.addUserMessage(content);

    // Commands this GUI answers itself stop here: the prompt is never sent, no
    // turn is started and no tokens are spent. The user's message is added
    // first so the transcript reads as a normal exchange — and so /clear wipes
    // its own invocation along with everything else.
    if (await handleSlashCommand(content)) {
      return;
    }

    // Start assistant message for streaming - pass conversation ID for proper tracking
    chatStore.startAssistantMessage(currentConvId);
    chatStore.setLoading(currentConvId, true);

    // Start buffering for this conversation, seeded with what is on screen, so
    // it keeps building a complete history if the user switches away mid-turn.
    chatStore.beginMessageBuffer(currentConvId);

    try {
      // Get SDK session ID for this conversation (for resume support)
      const resumeSessionId = conversationsStore.getSdkSessionId(currentConvId);

      // When resuming, use the conversation's stored CWD — the CLI stores session
      // files under a CWD-derived path, so it must match the original creation CWD.
      // Fall back to current global CWD for new conversations or if not available.
      const effectiveCwd = resumeSessionId
        ? (conversationsStore.getConversationWorkingDirectory(currentConvId) || filesStore.workingDirectory)
        : filesStore.workingDirectory;

      logger.info('Sending message to Claude', {
        conversationId: currentConvId,
        hasResumeSession: !!resumeSessionId,
        cwd: effectiveCwd,
        cwdMatchesGlobal: effectiveCwd === filesStore.workingDirectory,
      });

      // Send message via IPC with conversationId and optional resume session ID
      await window.electron.claude.send(currentConvId, content, effectiveCwd, resumeSessionId);
    } catch (err) {
      logger.error('Failed to send message', err);
      chatStore.setError(currentConvId, 'Failed to send message to Claude');
      chatStore.setLoading(currentConvId, false);
    }
  }

  /**
   * Approve a pending action
   * @param actionId - The action to approve
   * @param alwaysAllow - If true, automatically approve similar actions in the future
   */
  async function approveAction(actionId: string, alwaysAllow?: boolean, chosenScope?: PermissionScope) {
    const currentConvId = conversationsStore.currentConversationId;
    if (!currentConvId) {
      logger.error('Cannot approve action: no active conversation');
      return;
    }

    try {
      // Modified files are no longer recorded here. Approving is not the same
      // as writing, and this branch only runs for prompted tools — so every
      // auto-approved write went untracked. The store now records them when a
      // tool use reaches 'executed', whatever route it took to get there.
      chatStore.updateActionStatus(currentConvId, actionId, 'approved');
      chatStore.updateToolUseStatus(currentConvId, actionId, 'approved');
      await window.electron.claude.approve(currentConvId, actionId, undefined, alwaysAllow, chosenScope);
      chatStore.removePendingAction(currentConvId, actionId);
    } catch (err) {
      logger.error('Failed to approve action', err);
      chatStore.setError(currentConvId, 'Failed to approve action');
    }
  }

  /**
   * Reject a pending action
   */
  async function rejectAction(actionId: string) {
    const currentConvId = conversationsStore.currentConversationId;
    if (!currentConvId) {
      logger.error('Cannot reject action: no active conversation');
      return;
    }

    try {
      chatStore.updateActionStatus(currentConvId, actionId, 'rejected');
      chatStore.updateToolUseStatus(currentConvId, actionId, 'rejected');
      await window.electron.claude.reject(currentConvId, actionId);
      chatStore.removePendingAction(currentConvId, actionId);
    } catch (err) {
      logger.error('Failed to reject action', err);
      chatStore.setError(currentConvId, 'Failed to reject action');
    }
  }

  /**
   * Send the user's answer to a pending AskUserQuestion (or cancel it).
   * Marks the action as approved (or rejected when cancelled) in the store
   * and pings main via CLAUDE_USER_QUESTION_ANSWER.
   */
  async function sendQuestionAnswer(
    actionId: string,
    answers: AskUserQuestionAnswer[],
    cancelled: boolean,
  ) {
    const currentConvId = conversationsStore.currentConversationId;
    if (!currentConvId) {
      logger.error('Cannot send question answer: no active conversation');
      return;
    }

    try {
      chatStore.updateActionStatus(currentConvId, actionId, cancelled ? 'rejected' : 'approved');
      // The user's answer IS the result for AskUserQuestion — canUseTool is resolved
      // with deny+synthetic and no separate execution step follows. Move the inline
      // tool_use indicator directly to a terminal state so its spinner stops.
      chatStore.updateToolUseStatus(currentConvId, actionId, cancelled ? 'rejected' : 'executed');

      const response: AskUserQuestionResponse = {
        conversationId: currentConvId,
        actionId,
        answers,
        ...(cancelled ? { cancelled: true } : {}),
      };
      await window.electron.claude.answerQuestion(response);
      chatStore.removePendingAction(currentConvId, actionId);
    } catch (err) {
      logger.error('Failed to send question answer', err);
      chatStore.setError(currentConvId, 'Failed to send question answer');
    }
  }

  /**
   * Abort the current request for the active conversation
   */
  async function abort() {
    const currentConvId = conversationsStore.currentConversationId;
    if (!currentConvId) {
      logger.error('Cannot abort: no active conversation');
      return;
    }

    try {
      await window.electron.claude.abort(currentConvId);
      chatStore.setLoading(currentConvId, false);
      chatStore.finishStreaming(currentConvId);
    } catch (err) {
      logger.error('Failed to abort', err);
    }
  }

  /**
   * Abort a specific conversation's request
   */
  async function abortConversation(conversationId: string) {
    try {
      await window.electron.claude.abort(conversationId);
      chatStore.setLoading(conversationId, false);
      chatStore.finishStreaming(conversationId);
    } catch (err) {
      logger.error('Failed to abort conversation', { conversationId, err });
    }
  }

  /**
   * Clear the chat
   */
  function clearChat() {
    chatStore.clearMessages();
  }

  /**
   * Revoke a session permission
   */
  async function revokeSessionPermission(permissionId: string) {
    const currentConvId = conversationsStore.currentConversationId;
    if (!currentConvId) {
      logger.error('Cannot revoke permission: no active conversation');
      return;
    }

    try {
      await window.electron.claude.revokeSessionPermission(currentConvId, permissionId);
    } catch (err) {
      logger.error('Failed to revoke session permission', { error: err });
    }
  }

  /**
   * Set up IPC event listeners (singleton - only registers once)
   */
  function setupListeners() {
    // Only register listeners once across all component instances
    if (listenersRegistered) {
      logger.debug('IPC listeners already registered, skipping');
      return;
    }

    logger.info('Registering IPC listeners for Claude chat (multi-conversation)');
    listenersRegistered = true;

    // Handle streaming chunks - route to correct conversation
    cleanupChunk = window.electron.claude.onChunk((conversationId, chunk) => {
      // appendChunk writes to the on-screen list or the background buffer as
      // appropriate, so there is nothing to mirror here. The previous version
      // appended to a separate tracked copy, which only ever updated the last
      // assistant message and was then overwritten wholesale at save time.
      chatStore.appendChunk(conversationId, chunk);
    });

    // Handle tool use requests - route to correct conversation
    // Enriches the capture-created ToolUseMessage with actionId and pending status
    cleanupToolUse = window.electron.claude.onToolUse((conversationId, action) => {
      chatStore.addPendingAction(conversationId, action);
      chatStore.enrichToolUseFromPermission(conversationId, action);
    });

    // Handle errors - route to correct conversation
    cleanupError = window.electron.claude.onError((conversationId, error) => {
      chatStore.setError(conversationId, error);
      chatStore.setLoading(conversationId, false);
      chatStore.finishStreaming(conversationId);
      chatStore.completeToolUseMessages(conversationId);
    });

    // Handle completion - route to correct conversation
    cleanupDone = window.electron.claude.onDone(async (conversationId) => {
      // Turn-lifecycle diagnostics: the spinner is driven by isLoading and by
      // any message still flagged isStreaming, so record both around the only
      // event that clears them.
      const before = chatStore.getConversationState(conversationId);
      logger.info('[turn] done received', {
        conversationId,
        wasLoading: before?.isLoading,
        streamingMessageId: before?.streamingMessageId ?? null,
      });

      chatStore.setLoading(conversationId, false);
      chatStore.finishStreaming(conversationId);
      chatStore.completeToolUseMessages(conversationId);

      // If anything is still flagged streaming after this, the spinner will
      // stay on screen regardless of isLoading — say so loudly rather than
      // leaving it to be discovered in the UI.
      const stillStreaming = chatStore.messages.filter((m) => m.isStreaming).length;
      if (stillStreaming > 0) {
        logger.warn('[turn] spinner will persist — messages still marked streaming', {
          conversationId,
          stillStreaming,
        });
      }

      // Note: do NOT call completeRunningTasks here — background tasks may still be
      // running on the server. They will be updated via task_notification on session resume.

      // Save the conversation
      // If this is the current conversation, use normal save
      // If user switched away, we need to reconstruct and save
      if (conversationId === conversationsStore.currentConversationId) {
        // Current conversation - save normally
        await conversationsStore.saveCurrentConversation();
        // Release the buffer here too, or a later switch away would read a
        // stale snapshot from this finished turn.
        chatStore.endMessageBuffer(conversationId);
      } else {
        // User switched away - need to save this conversation in background
        logger.info('Saving completed conversation in background', { conversationId });

        const messages = chatStore.getBufferedMessages(conversationId);

        if (messages && messages.length > 0) {
          // Clear any lingering streaming flag. The content itself is already
          // on each message — appendChunk writes into this buffer — so unlike
          // before there is nothing to copy across from the streaming state.
          const lastMsg = messages[messages.length - 1];
          if (lastMsg.role === 'assistant') {
            lastMsg.isStreaming = false;
          }

          await conversationsStore.saveConversation(conversationId, messages);
        }

        chatStore.endMessageBuffer(conversationId);
      }
    });

    // The main-loop model the CLI reports. Registered once here and held in
    // the chat store so the usage bar, the picker and the mismatch banner all
    // read one value instead of each opening its own listener.
    cleanupActiveModel = window.electron.claude.onActiveModel((conversationId, model) => {
      chatStore.setActiveModel(conversationId, model);
      logger.debug('Active model reported', { conversationId, model });
    });

    // Per-agent model and token spend, attributed to the spawning tool_use.
    cleanupSubagentActivity = window.electron.claude.onSubagentActivity((conversationId, activity) => {
      chatStore.recordSubagentActivity(conversationId, activity);
    });

    // Handle slash commands updates from SDK
    cleanupSlashCommands = window.electron.claude.onSlashCommands((conversationId, commands) => {
      sharedSlashCommands.value = commands;
      logger.debug('Received slash commands from SDK', { conversationId, count: commands.length });
    });

    // Claude Code's transcript id for each user turn — the rewind target.
    cleanupUserTurnUuid = window.electron.claude.onUserTurnUuid((conversationId, uuid) => {
      chatStore.recordUserTurnUuid(conversationId, uuid);
    });

    // Handle background task notifications - route to correct conversation
    cleanupTaskNotification = window.electron.claude.onTaskNotification((conversationId, notification) => {
      logger.info('Received task notification', {
        conversationId,
        taskId: notification.taskId,
        status: notification.status,
        description: notification.description,
      });
      chatStore.handleTaskNotification(conversationId, notification);
    });

    // The SDK's authoritative live-task set. The notifications above carry the
    // real outcome and are the normal path; this closes the hole when one is
    // missed, which otherwise left a finished task displayed as running
    // indefinitely.
    cleanupBackgroundTasksChanged = window.electron.claude.onBackgroundTasksChanged((conversationId, tasks) => {
      logger.debug('Received live background task set', {
        conversationId,
        count: tasks.length,
      });
      chatStore.reconcileBackgroundTasks(conversationId, tasks);
    });

    // Handle usage updates (token counts, cost, context info) - route to correct conversation
    cleanupUsageUpdate = window.electron.claude.onUsageUpdate((conversationId, usage) => {
      logger.debug('Received usage update', {
        conversationId,
        totalCostUSD: usage.totalCostUSD,
        inputTokens: usage.usage.inputTokens,
        outputTokens: usage.usage.outputTokens,
        numTurns: usage.numTurns,
      });
      chatStore.updateSessionUsage(conversationId, usage);
    });

    // Handle active query count changes
    cleanupActiveQueries = window.electron.claude.onActiveQueriesChange(
      (count, maxCount, processingCount, activeConversationIds) => {
        logger.debug('Active queries changed', {
          count,
          maxCount,
          processingCount,
          activeConversationIds,
        });
        chatStore.updateActiveQueries(count, maxCount, processingCount);
        // The authoritative set, so a busy flag left wrong by a missed or
        // misattributed CLAUDE_DONE is corrected rather than persisting for
        // the rest of the session.
        chatStore.reconcileActiveConversations(activeConversationIds);
      },
    );

    // Handle SDK session ID for resume support
    cleanupSessionId = window.electron.claude.onSessionId((conversationId, sessionId) => {
      if (!sessionId) {
        logger.info('Clearing stale SDK session ID (resume failed)', { conversationId });
        conversationsStore.clearSdkSessionId(conversationId);
        return;
      }
      logger.info('Received SDK session ID', {
        conversationId,
        sessionIdPreview: sessionId.slice(0, 20) + '...',
      });
      conversationsStore.setSdkSessionId(conversationId, sessionId);
    });

    // Handle session permission changes
    cleanupSessionPermissions = window.electron.claude.onSessionPermissionsChanged((conversationId, permissions) => {
      logger.debug('Session permissions changed', { conversationId, count: permissions.length });
      chatStore.updateSessionPermissions(conversationId, permissions);
    });

    // Handle tool execution completed - update inline tool use indicator and dismiss
    // any lingering ActionApproval (e.g. auto-resolved by "allow for this session")
    cleanupToolExecuted = window.electron.claude.onToolExecuted((conversationId, actionId) => {
      logger.debug('Tool executed', { conversationId, actionId });
      chatStore.updateToolUseStatus(conversationId, actionId, 'executed');
      chatStore.removePendingAction(conversationId, actionId);
    });

    // Handle system notes (compaction, status changes) — rendered as separators
    cleanupSystemNote = window.electron.claude.onSystemNote((conversationId, note) => {
      logger.info('System note received', { conversationId, note });
      if (conversationId === conversationsStore.currentConversationId) {
        chatStore.addSystemMessage(note);
      }
    });

    // Handle tool capture (all tools, including auto-approved) — creates inline indicator
    cleanupToolCapture = window.electron.claude.onToolCapture((conversationId, capture) => {
      logger.debug('Tool capture received', { conversationId, toolName: capture.toolName, blockId: capture.toolUseBlockId });
      chatStore.addAutoToolUseMessage(conversationId, capture);
    });

    // Handle tool result (output file written to disk)
    cleanupToolResult = window.electron.claude.onToolResult((conversationId, result) => {
      logger.debug('Tool result received', { conversationId, blockId: result.toolUseBlockId });
      chatStore.updateToolUseResult(conversationId, result);
    });

    // Handle auth invalidation (401 from API) - refresh config so UI reacts
    cleanupAuthInvalidated = window.electron.auth.onInvalidated(() => {
      logger.warn('Auth invalidated — credentials cleared by main process, reloading config');
      settingsStore.loadConfig();
      // Clear all stale SDK session IDs so conversations don't attempt to resume
      // under a different auth context (e.g. after migration or re-login)
      conversationsStore.clearAllSdkSessionIds();
    });
  }

  /**
   * Clean up IPC event listeners (only when last component unmounts)
   */
  function cleanupListeners() {
    // Only cleanup when no more components are using the listeners
    if (listenerRefCount > 0) {
      logger.debug('Other components still using listeners, skipping cleanup');
      return;
    }

    if (!listenersRegistered) {
      return;
    }

    logger.info('Cleaning up IPC listeners for Claude chat');
    listenersRegistered = false;

    if (cleanupChunk) {
      cleanupChunk();
      cleanupChunk = null;
    }
    if (cleanupToolUse) {
      cleanupToolUse();
      cleanupToolUse = null;
    }
    if (cleanupError) {
      cleanupError();
      cleanupError = null;
    }
    if (cleanupDone) {
      cleanupDone();
      cleanupDone = null;
    }
    if (cleanupSlashCommands) {
      cleanupSlashCommands();
      cleanupSlashCommands = null;
    }
    if (cleanupActiveModel) {
      cleanupActiveModel();
      cleanupActiveModel = null;
    }
    if (cleanupSubagentActivity) {
      cleanupSubagentActivity();
      cleanupSubagentActivity = null;
    }
    if (cleanupUserTurnUuid) {
      cleanupUserTurnUuid();
      cleanupUserTurnUuid = null;
    }
    if (cleanupBackgroundTasksChanged) {
      cleanupBackgroundTasksChanged();
      cleanupBackgroundTasksChanged = null;
    }
    if (cleanupTaskNotification) {
      cleanupTaskNotification();
      cleanupTaskNotification = null;
    }
    if (cleanupUsageUpdate) {
      cleanupUsageUpdate();
      cleanupUsageUpdate = null;
    }
    if (cleanupActiveQueries) {
      cleanupActiveQueries();
      cleanupActiveQueries = null;
    }
    if (cleanupSessionId) {
      cleanupSessionId();
      cleanupSessionId = null;
    }
    if (cleanupSessionPermissions) {
      cleanupSessionPermissions();
      cleanupSessionPermissions = null;
    }
    if (cleanupToolExecuted) {
      cleanupToolExecuted();
      cleanupToolExecuted = null;
    }
    if (cleanupSystemNote) {
      cleanupSystemNote();
      cleanupSystemNote = null;
    }
    if (cleanupToolCapture) {
      cleanupToolCapture();
      cleanupToolCapture = null;
    }
    if (cleanupToolResult) {
      cleanupToolResult();
      cleanupToolResult = null;
    }
    if (cleanupAuthInvalidated) {
      cleanupAuthInvalidated();
      cleanupAuthInvalidated = null;
    }
  }

  // Set up listeners on mount, clean up on unmount
  // Uses ref counting to handle multiple component instances
  onMounted(() => {
    // Increment ref count BEFORE setup to track this component
    listenerRefCount++;
    setupListeners();
    // Load available slash commands (only if not already loaded)
    if (sharedSlashCommands.value.length === 0) {
      loadSlashCommands();
    }
    // Load current active query status
    loadActiveQueries();
  });

  onUnmounted(() => {
    // Decrement ref count BEFORE cleanup check
    // Guard against going negative (defensive programming)
    if (listenerRefCount > 0) {
      listenerRefCount--;
    }
    cleanupListeners();
  });

  return {
    // Actions
    sendMessage,
    approveAction,
    rejectAction,
    sendQuestionAnswer,
    abort,
    abortConversation,
    clearChat,
    revokeSessionPermission,

    // Store refs (for convenience) - these are now computed from current conversation
    messages: chatStore.messages,
    pendingActions: chatStore.pendingActions,
    isLoading: chatStore.isLoading,
    error: chatStore.error,

    // Resource limit info
    activeQueryCount: chatStore.activeQueryCount,
    maxConcurrentQueries: chatStore.maxConcurrentQueries,
    isAtResourceLimit: chatStore.isAtResourceLimit,
    canStartNewQuery: chatStore.canStartNewQuery,

    // Slash commands from SDK
    slashCommands,
  };
}
