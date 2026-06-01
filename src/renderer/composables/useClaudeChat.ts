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

import type { SlashCommandInfo, ChatMessage, PendingAction, PermissionScope } from '@shared/types';

import { useChatStore } from '../stores/chat';
import { useConversationsStore } from '../stores/conversations';
import { useFilesStore } from '../stores/files';
import { useSettingsStore } from '../stores/settings';
import { logger } from '../utils/logger';

// Singleton state for IPC listeners - shared across all composable instances
// This prevents duplicate listener registration when multiple components use this composable
let listenersRegistered = false;
let listenerRefCount = 0;
let cleanupChunk: (() => void) | null = null;
let cleanupToolUse: (() => void) | null = null;
let cleanupError: (() => void) | null = null;
let cleanupDone: (() => void) | null = null;
let cleanupSlashCommands: (() => void) | null = null;
let cleanupCommandAction: (() => void) | null = null;
let cleanupTaskNotification: (() => void) | null = null;
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

// Track messages per conversation for background saves (when user switches away)
// This is needed because we need to reconstruct the message list for non-current conversations
const conversationMessages = new Map<string, ChatMessage[]>();

/**
 * Get in-memory messages for a conversation that may be running in background
 * This is used when switching to a conversation to get the latest messages
 * without having to wait for the file to be saved
 */
export function getInMemoryMessages(conversationId: string): ChatMessage[] | null {
  return conversationMessages.get(conversationId) || null;
}

export function useClaudeChat() {
  const chatStore = useChatStore();
  const conversationsStore = useConversationsStore();
  const filesStore = useFilesStore();
  const settingsStore = useSettingsStore();

  // Reference to shared slash commands
  const slashCommands = sharedSlashCommands;

  /**
   * Check if a message is a slash command
   */
  function isSlashCommand(message: string): SlashCommandInfo | null {
    const trimmed = message.trim();
    if (!trimmed.startsWith('/')) return null;

    // Extract command name (without arguments)
    const cmdPart = trimmed.split(' ')[0].slice(1); // Remove leading /

    return slashCommands.value.find((cmd) => cmd.name === cmdPart) || null;
  }

  /**
   * Load available slash commands from the SDK
   */
  async function loadSlashCommands(): Promise<void> {
    try {
      const commands = await window.electron.claude.getCommands();
      slashCommands.value = commands;
      logger.debug('Loaded slash commands', { count: commands.length });
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
   * Extract file path from a pending action (if it modifies a file)
   */
  function getModifiedFilePath(action: PendingAction): string | null {
    switch (action.type) {
      case 'file-edit':
      case 'file-create':
      case 'file-delete':
        return action.details.filePath;
      default:
        return null;
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
        `Maximum concurrent conversations (${chatStore.maxConcurrentQueries}) reached. ` +
        `Please wait for another conversation to complete or cancel it.`
      );
      return;
    }

    // Clear any previous error and modified files from last query
    chatStore.clearError();
    chatStore.clearModifiedFiles(currentConvId);

    // Add user message to chat
    chatStore.addUserMessage(content);

    // Check if this is a slash command
    const slashCmd = isSlashCommand(content);
    if (slashCmd) {
      logger.info('Slash command detected', {
        command: content.split(' ')[0],
        name: slashCmd.name,
        description: slashCmd.description,
      });
    }

    // Start assistant message for streaming - pass conversation ID for proper tracking
    chatStore.startAssistantMessage(currentConvId);
    chatStore.setLoading(currentConvId, true);

    // Track messages for this conversation (for background save)
    // We include the empty assistant message so it can accumulate content even when not current
    conversationMessages.set(currentConvId, [...chatStore.messages]);

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
      // Track file modification before removing the action
      const action = chatStore.pendingActions.find((a) => a.id === actionId);
      if (action) {
        const filePath = getModifiedFilePath(action);
        if (filePath) {
          chatStore.trackFileModification(currentConvId, filePath);
        }
      }

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
      chatStore.appendChunk(conversationId, chunk);

      // Update tracked messages for this conversation
      if (conversationId === conversationsStore.currentConversationId) {
        conversationMessages.set(conversationId, [...chatStore.messages]);
      } else {
        // For non-current conversations, update the tracked messages with the new chunk
        const tracked = conversationMessages.get(conversationId);
        if (tracked && tracked.length > 0) {
          const lastMsg = tracked[tracked.length - 1];
          if (lastMsg.role === 'assistant') {
            lastMsg.content += chunk;
          }
        }
      }
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
      logger.info('Claude done event received', { conversationId });

      chatStore.setLoading(conversationId, false);
      chatStore.finishStreaming(conversationId);
      chatStore.completeToolUseMessages(conversationId);
      // Note: do NOT call completeRunningTasks here — background tasks may still be
      // running on the server. They will be updated via task_notification on session resume.

      // Save the conversation
      // If this is the current conversation, use normal save
      // If user switched away, we need to reconstruct and save
      if (conversationId === conversationsStore.currentConversationId) {
        // Current conversation - save normally
        await conversationsStore.saveCurrentConversation();
      } else {
        // User switched away - need to save this conversation in background
        logger.info('Saving completed conversation in background', { conversationId });

        // Get the streaming content that was accumulated
        const state = chatStore.getConversationState(conversationId);

        // Try to get the tracked messages for this conversation
        let messages = conversationMessages.get(conversationId);

        if (messages && messages.length > 0) {
          // Update the last assistant message with the full streamed content
          const lastMsg = messages[messages.length - 1];
          if (lastMsg.role === 'assistant') {
            lastMsg.content = state.currentStreamingContent || lastMsg.content;
            lastMsg.isStreaming = false;
          }

          await conversationsStore.saveConversation(conversationId, messages);
        }

        // Clean up tracked messages
        conversationMessages.delete(conversationId);
      }
    });

    // Handle slash commands updates from SDK
    cleanupSlashCommands = window.electron.claude.onSlashCommands((conversationId, commands) => {
      sharedSlashCommands.value = commands;
      logger.debug('Received slash commands from SDK', { conversationId, count: commands.length });
    });

    // Handle command actions (clear, compact, etc.)
    cleanupCommandAction = window.electron.claude.onCommandAction((conversationId, action) => {
      logger.info('Received command action', { conversationId, action });

      // Only apply to current conversation
      if (conversationId === conversationsStore.currentConversationId) {
        if (action === 'clear') {
          setTimeout(() => {
            chatStore.clearMessages();
            logger.info('Chat cleared via /clear command');
          }, 500);
        }
      }
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
    cleanupActiveQueries = window.electron.claude.onActiveQueriesChange((count, maxCount, processingCount) => {
      logger.debug('Active queries changed', { count, maxCount, processingCount });
      chatStore.updateActiveQueries(count, maxCount, processingCount);
    });

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

    // Handle tool execution completed - update inline tool use indicator in real-time
    cleanupToolExecuted = window.electron.claude.onToolExecuted((conversationId, actionId) => {
      logger.debug('Tool executed', { conversationId, actionId });
      chatStore.updateToolUseStatus(conversationId, actionId, 'executed');
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
      chatStore.updateToolUseResult(conversationId, result.toolUseBlockId, result.outputFile);
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
    if (cleanupCommandAction) {
      cleanupCommandAction();
      cleanupCommandAction = null;
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
