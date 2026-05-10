/**
 * Conversations store - manages conversation persistence and history
 * Updated for multi-conversation support
 */

import { defineStore, storeToRefs } from 'pinia';
import { ref, computed, watch } from 'vue';

import type { ChatMessage, Conversation } from '@shared/types';

import { getInMemoryMessages } from '../composables/useClaudeChat';
import { CONSTANTS } from '../constants/app';
import { generateId, ID_PREFIXES } from '../utils/id';
import { logger } from '../utils/logger';

import { useChatStore } from './chat';
import { useSettingsStore } from './settings';

export const useConversationsStore = defineStore('conversations', () => {
  // State
  const conversations = ref<Conversation[]>([]);
  const currentConversationId = ref<string | null>(null);
  const isLoading = ref(false);
  const isSaving = ref(false);
  const error = ref<string | null>(null);
  const isInitialized = ref(false);

  // SDK session IDs per conversation (for resume support)
  // This is stored in memory, not persisted - sessions are only valid for the current app session
  const sdkSessionIds = ref<Map<string, string>>(new Map());

  // Set up watchers at store creation time for proper reactivity
  const chatStore = useChatStore();
  const { messages: chatMessages } = storeToRefs(chatStore);

  // Note: Per-conversation save on streaming completion is handled by the useClaudeChat composable
  // via the onDone event handler, which has access to the conversationId from the event

  // Watch for message count changes in current conversation - save when first user message is added
  // This ensures the conversation appears in history immediately
  watch(
    () => chatMessages.value.length,
    (newLength, oldLength) => {
      if (!isInitialized.value) return; // Don't save before initialization

      logger.debug('Messages length changed', {
        newLength,
        oldLength,
        conversationId: currentConversationId.value,
      });

      // Save when first message is added (user message)
      // This makes the conversation appear in history immediately
      if (oldLength === 0 && newLength > 0 && currentConversationId.value) {
        logger.info('First message added, saving conversation to history');
        saveCurrentConversation().catch((err) => {
          logger.error('Failed to save conversation after first message', err);
        });
      }
    }
  );

  // Getters
  const currentConversation = computed(() => {
    if (!currentConversationId.value) return null;
    return conversations.value.find((c: Conversation) => c.id === currentConversationId.value) || null;
  });

  const hasConversations = computed(() => conversations.value.length > 0);

  const sortedConversations = computed(() => {
    return [...conversations.value].sort((a, b) => b.updatedAt - a.updatedAt);
  });

  // Actions

  /**
   * Load the list of all conversations (metadata only)
   */
  async function loadConversationList(): Promise<void> {
    isLoading.value = true;
    error.value = null;
    try {
      const list = await window.electron.conversation.list();
      conversations.value = list;
      logger.debug('Loaded conversation list', { count: list.length });
    } catch (err) {
      logger.error('Failed to load conversations', err);
      error.value = 'Failed to load conversations';
    } finally {
      isLoading.value = false;
    }
  }

  /**
   * Load a specific conversation and its messages
   */
  async function loadConversation(id: string): Promise<boolean> {
    isLoading.value = true;
    error.value = null;

    try {
      const conversation = await window.electron.conversation.get(id);
      if (!conversation) {
        error.value = 'Conversation not found';
        return false;
      }

      // Update in list with full data
      const index = conversations.value.findIndex((c: Conversation) => c.id === id);
      if (index !== -1) {
        conversations.value[index] = conversation;
      } else {
        conversations.value.push(conversation);
      }

      // Restore SDK session ID from persisted data (for resume support after app restart)
      if (conversation.sdkSessionId) {
        sdkSessionIds.value.set(id, conversation.sdkSessionId);
        logger.info('Restored SDK session ID from saved conversation', {
          id,
          sessionIdPreview: conversation.sdkSessionId.slice(0, 20) + '...',
        });
      }

      // Update current conversation ID in both stores
      currentConversationId.value = id;
      chatStore.setCurrentConversation(id);
      persistLastConversationId(id);

      // Check if this conversation has in-memory messages (was running in background)
      // These are more up-to-date than the saved file
      const inMemoryMessages = getInMemoryMessages(id);
      const state = chatStore.getConversationState(id);

      if (inMemoryMessages && inMemoryMessages.length > 0) {
        // Use in-memory messages - they're more current than the saved file
        logger.info('Using in-memory messages for background conversation', {
          id,
          messageCount: inMemoryMessages.length,
          isLoading: state.isLoading,
        });

        // Deep clone to avoid reactivity issues
        const messages = JSON.parse(JSON.stringify(inMemoryMessages)) as ChatMessage[];

        // If still streaming, update the last message with accumulated content
        if (state.isLoading && state.streamingMessageId && state.currentStreamingContent) {
          const lastMsg = messages[messages.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            lastMsg.content = state.currentStreamingContent;
            lastMsg.isStreaming = true;
          }
        }

        chatStore.loadMessages(messages);
      } else {
        // Load messages from saved file
        chatStore.loadMessages(conversation.messages);

        // If this conversation was streaming, check for buffered content
        if (state.streamingMessageId && state.currentStreamingContent) {
          // There's buffered streaming content - find the message and update it
          const lastMessage = chatStore.messages[chatStore.messages.length - 1];
          if (lastMessage && lastMessage.role === 'assistant' && lastMessage.id === state.streamingMessageId) {
            // Sync the content
            lastMessage.content = state.currentStreamingContent;
            lastMessage.isStreaming = state.isLoading;
          }
        }
      }

      // Update working directory if different
      const settingsStore = useSettingsStore();
      if (conversation.workingDirectory && conversation.workingDirectory !== settingsStore.workingDirectory) {
        await settingsStore.setWorkingDirectory(conversation.workingDirectory);
      }

      logger.info('Loaded conversation', { id, messageCount: conversation.messages.length });
      return true;
    } catch (err) {
      logger.error('Failed to load conversation', err);
      error.value = 'Failed to load conversation';
      return false;
    } finally {
      isLoading.value = false;
    }
  }

  /**
   * Switch to a different conversation
   * This properly handles switching from a streaming conversation
   */
  async function switchConversation(id: string): Promise<boolean> {
    if (id === currentConversationId.value) {
      return true; // Already on this conversation
    }

    logger.info('Switching conversation', {
      from: currentConversationId.value,
      to: id,
    });

    // Save current conversation before switching (if it has messages)
    if (currentConversationId.value && chatStore.messages.length > 0) {
      await saveCurrentConversation().catch((err) => {
        logger.error('Failed to save conversation before switch', err);
      });
    }

    // Load the target conversation
    return loadConversation(id);
  }

  /**
   * Build a conversation object ready for saving.
   * Centralizes title generation, message cloning, and metadata handling.
   */
  function buildConversationPayload(
    conversationId: string,
    messages: ChatMessage[],
    workingDirectory: string
  ): Conversation {
    // Deep clone messages to strip ALL Vue reactivity (including nested objects)
    // Vue proxies can't be cloned across IPC - use JSON round-trip for complete deproxification
    const rawMessages: ChatMessage[] = JSON.parse(JSON.stringify(messages));
    const existingConv = conversations.value.find((c: Conversation) => c.id === conversationId);

    // Preserve existing custom title if it was explicitly set via rename
    const generatedTitle = generateTitle(messages);
    // Use the customTitle flag to determine if the title was manually set
    const title = existingConv?.customTitle ? existingConv.title : generatedTitle;

    // Get SDK session ID from in-memory map (for persistence)
    const sdkSessionId = sdkSessionIds.value.get(conversationId);

    // Use last message timestamp for ordering (so history sorts by last message, not last access)
    const lastMessageAt = rawMessages.length > 0
      ? rawMessages[rawMessages.length - 1].timestamp
      : Date.now();

    return {
      id: conversationId,
      title,
      customTitle: existingConv?.customTitle,
      workingDirectory,
      messages: rawMessages,
      createdAt: existingConv?.createdAt || Date.now(),
      updatedAt: lastMessageAt,
      sdkSessionId,
    };
  }

  /**
   * Update the conversations list after a successful save.
   */
  function updateConversationList(conversation: Conversation): void {
    const index = conversations.value.findIndex((c: Conversation) => c.id === conversation.id);
    // Store without messages for list view (saves memory)
    const listEntry = { ...conversation, messages: [] };
    if (index !== -1) {
      conversations.value[index] = listEntry;
    } else {
      conversations.value.push(listEntry);
    }
  }

  /**
   * Core save implementation used by both saveCurrentConversation and saveConversation.
   */
  async function executeSave(
    conversation: Conversation,
    options: { useTimeout: boolean; logPrefix: string }
  ): Promise<void> {
    logger.info(`Saving conversation${options.logPrefix}`, {
      id: conversation.id,
      messageCount: conversation.messages.length,
      title: conversation.title?.slice(0, 30),
    });

    if (options.useTimeout) {
      const savePromise = window.electron.conversation.save(conversation);
      const timeoutMs = CONSTANTS.CONVERSATION.SAVE_TIMEOUT_MS;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Save operation timed out after ${timeoutMs / 1000} seconds`)), timeoutMs);
      });
      await Promise.race([savePromise, timeoutPromise]);
    } else {
      await window.electron.conversation.save(conversation);
    }

    updateConversationList(conversation);
  }

  /**
   * Save the current conversation
   * Returns true if save was successful, false otherwise
   */
  async function saveCurrentConversation(): Promise<boolean> {
    if (!currentConversationId.value) {
      logger.debug('No current conversation ID, skipping save');
      return false;
    }

    const settingsStore = useSettingsStore();

    // Don't save if no messages
    if (chatStore.messages.length === 0) {
      logger.debug('No messages to save');
      return false;
    }

    // Validate workingDirectory is set
    if (!settingsStore.workingDirectory) {
      logger.warn('Cannot save conversation: working directory not set');
      error.value = 'Cannot save conversation: working directory not set';
      return false;
    }

    // Prevent concurrent saves
    if (isSaving.value) {
      logger.debug('Save already in progress, skipping duplicate save');
      return false;
    }

    isSaving.value = true;
    error.value = null;

    try {
      const conversation = buildConversationPayload(
        currentConversationId.value,
        chatStore.messages,
        settingsStore.workingDirectory
      );

      await executeSave(conversation, { useTimeout: true, logPrefix: '' });
      logger.info('Conversation saved successfully', { id: conversation.id });
      return true;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error('Failed to save conversation', {
        error: errorMessage,
        conversationId: currentConversationId.value,
      });
      error.value = `Failed to save conversation: ${errorMessage}`;
      return false;
    } finally {
      isSaving.value = false;
    }
  }

  /**
   * Save a specific conversation (not necessarily the current one)
   * Used for background saves of streaming conversations
   */
  async function saveConversation(conversationId: string, messages: ChatMessage[]): Promise<boolean> {
    if (messages.length === 0) {
      logger.debug('No messages to save for conversation', { conversationId });
      return false;
    }

    const settingsStore = useSettingsStore();

    // Validate workingDirectory is set
    if (!settingsStore.workingDirectory) {
      logger.warn('Cannot save conversation: working directory not set');
      return false;
    }

    try {
      const conversation = buildConversationPayload(
        conversationId,
        messages,
        settingsStore.workingDirectory
      );

      await executeSave(conversation, { useTimeout: false, logPrefix: ' (background)' });
      return true;
    } catch (err) {
      logger.error('Failed to save conversation (background)', { conversationId, error: err });
      return false;
    }
  }

  /**
   * Create a new conversation and make it current
   */
  function createNewConversation(): string {
    // Clear current chat messages
    chatStore.clearMessages();

    // Generate new conversation ID
    const id = generateId(ID_PREFIXES.CONVERSATION);

    // Update both stores
    currentConversationId.value = id;
    chatStore.setCurrentConversation(id);

    persistLastConversationId(id);

    logger.info('Created new conversation', { id });
    return id;
  }

  /**
   * Rename a conversation
   */
  async function renameConversation(id: string, newTitle: string): Promise<boolean> {
    try {
      await window.electron.conversation.rename(id, newTitle);

      // Update in local list
      const index = conversations.value.findIndex((c: Conversation) => c.id === id);
      if (index !== -1) {
        conversations.value[index] = {
          ...conversations.value[index],
          title: newTitle.trim(),
          customTitle: true,  // Mark as manually renamed
          updatedAt: Date.now(),
        };
      }

      logger.info('Renamed conversation', { id, newTitle: newTitle.slice(0, 30) });
      return true;
    } catch (err) {
      logger.error('Failed to rename conversation', err);
      error.value = 'Failed to rename conversation';
      return false;
    }
  }

  /**
   * Delete a conversation
   */
  async function deleteConversation(id: string): Promise<void> {
    try {
      await window.electron.conversation.delete(id);

      // Remove from list
      const index = conversations.value.findIndex((c: Conversation) => c.id === id);
      if (index !== -1) {
        conversations.value.splice(index, 1);
      }

      // Clear conversation state from chat store
      chatStore.clearConversationState(id);

      // Clear session permissions in the main process
      try {
        await window.electron.claude.clearSessionPermissions(id);
      } catch (permErr) {
        logger.warn('Failed to clear session permissions for deleted conversation', { id, error: permErr });
      }

      // If it was the current conversation, create a new one
      if (currentConversationId.value === id) {
        createNewConversation();
      }

      logger.info('Deleted conversation', { id });
    } catch (err) {
      logger.error('Failed to delete conversation', err);
      error.value = 'Failed to delete conversation';
    }
  }

  /**
   * Check if a conversation has an active query (loading)
   */
  function isConversationActive(id: string): boolean {
    return chatStore.isConversationLoading(id);
  }

  /**
   * Generate a title from the first user message
   */
  function generateTitle(messages: ChatMessage[]): string {
    const firstUserMessage = messages.find((m) => m.role === 'user');
    if (firstUserMessage) {
      const content = firstUserMessage.content.trim();
      if (content.length <= CONSTANTS.CONVERSATION.TITLE_MAX_LENGTH) {
        return content;
      }
      return content.slice(0, CONSTANTS.CONVERSATION.TITLE_TRUNCATE_LENGTH) + '...';
    }
    return 'New Conversation';
  }

  /**
   * Clear error
   */
  function clearError(): void {
    error.value = null;
  }

  /**
   * Set SDK session ID for a conversation (for resume support)
   */
  function setSdkSessionId(conversationId: string, sessionId: string): void {
    sdkSessionIds.value.set(conversationId, sessionId);
    logger.info('Stored SDK session ID for conversation', {
      conversationId,
      sessionIdPreview: sessionId.slice(0, 20) + '...',
    });
  }

  /**
   * Get SDK session ID for a conversation (for resume support)
   */
  function getSdkSessionId(conversationId: string): string | undefined {
    return sdkSessionIds.value.get(conversationId);
  }

  /**
   * Check if the current conversation has an active SDK session.
   * Used to determine if model changes will require a session reset.
   */
  function currentConversationHasSession(): boolean {
    if (!currentConversationId.value) return false;
    return sdkSessionIds.value.has(currentConversationId.value);
  }

  /**
   * Clear SDK session ID for a conversation
   */
  function clearSdkSessionId(conversationId: string): void {
    sdkSessionIds.value.delete(conversationId);
    logger.info('Cleared SDK session ID for conversation', { conversationId });
  }

  /**
   * Clear SDK session ID for the current conversation.
   * Used when the user confirms a model change mid-conversation.
   */
  function clearCurrentSdkSessionId(): void {
    if (currentConversationId.value) {
      clearSdkSessionId(currentConversationId.value);
    }
  }

  /**
   * Persist the last active conversation ID to config for auto-restore on startup.
   */
  function persistLastConversationId(id: string): void {
    window.electron.config.set({ lastConversationId: id }).catch((err) => {
      logger.error('Failed to persist last conversation ID', err);
    });
  }

  /**
   * Initialize the store - load conversations and enable auto-save
   */
  async function initialize(): Promise<void> {
    logger.info('Initializing conversations store');

    // Wait for conversation list to load before proceeding
    await loadConversationList();

    // Try to restore the last active conversation
    if (!currentConversationId.value) {
      let restored = false;
      try {
        const config = await window.electron.config.get();
        if (config.lastConversationId) {
          const exists = conversations.value.some(
            (c: Conversation) => c.id === config.lastConversationId
          );
          if (exists) {
            restored = await loadConversation(config.lastConversationId);
          }
        }
      } catch (err) {
        logger.error('Failed to restore last conversation', err);
      }

      if (!restored) {
        createNewConversation();
      }
    }

    // Enable auto-save watchers (they're created at store creation time)
    isInitialized.value = true;

    logger.info('Conversations store initialized', {
      currentConversationId: currentConversationId.value,
      messageCount: chatMessages.value.length,
    });
  }

  /**
   * Cleanup on unmount - saves current conversation before disabling watchers
   * Returns a promise that resolves when cleanup is complete
   */
  async function cleanup(): Promise<void> {
    // Save current conversation before disabling watchers
    // This ensures no data loss on app close
    try {
      await saveCurrentConversation();
    } catch (err) {
      logger.error('Failed to save conversation during cleanup', err);
    }

    // Disable auto-save watchers after save completes
    isInitialized.value = false;
  }

  return {
    // State
    conversations,
    currentConversationId,
    isLoading,
    isSaving,
    error,

    // Getters
    currentConversation,
    hasConversations,
    sortedConversations,

    // Actions
    loadConversationList,
    loadConversation,
    switchConversation,
    saveCurrentConversation,
    saveConversation,
    createNewConversation,
    renameConversation,
    deleteConversation,
    isConversationActive,
    clearError,
    initialize,
    cleanup,

    // SDK session management (for resume support)
    setSdkSessionId,
    getSdkSessionId,
    clearSdkSessionId,
    clearCurrentSdkSessionId,
    currentConversationHasSession,
  };
});
