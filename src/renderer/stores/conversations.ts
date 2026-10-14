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
import { forgetPosition } from '../utils/scroll-memory';

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

  /**
   * True when the active conversation was started in a different execution
   * mode than the user is currently using. The SDK and channel CLI keep
   * separate session stores, so resume across modes always fails — block
   * sends and surface a clear banner instead of letting the SDK error path
   * trip silently.
   */
  const currentModeMismatch = computed(() => {
    const conv = currentConversation.value;
    if (!conv) return null;
    const settingsStore = useSettingsStore();
    const convMode = conv.executionMode;
    if (!convMode || convMode === settingsStore.executionMode) return null;
    return { conversationMode: convMode, currentMode: settingsStore.executionMode };
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
      // Migration: stamp the current execution mode onto any conversation that
      // doesn't already have one. We do this in memory only; the file gets
      // updated on the next save. This preserves the user's expectation that
      // pre-existing conversations "belong to" whatever mode they're currently
      // in, while keeping any newly created conversation anchored to its
      // creation mode for future mode-switch detection.
      const settingsStore = useSettingsStore();
      const currentMode = settingsStore.executionMode;
      conversations.value = list.map((c: Conversation) =>
        c.executionMode ? c : { ...c, executionMode: currentMode },
      );
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

      // Same migration as loadConversationList: stamp current mode onto
      // pre-existing conversations missing the field.
      const settingsStoreForMigration = useSettingsStore();
      if (!conversation.executionMode) {
        conversation.executionMode = settingsStoreForMigration.executionMode;
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

      // Restore the persisted session usage so the context-usage bar can
      // render straight away — without this it stays blank until the next
      // query updates it, which is bad UX when reopening an old conversation.
      // Don't clobber an in-memory value that's already fresher (e.g. when
      // the conversation was running in the background).
      const stateForUsage = chatStore.getConversationState(id);
      if (!stateForUsage.sessionUsage && conversation.lastSessionUsage) {
        chatStore.updateSessionUsage(id, conversation.lastSessionUsage);
      }

      // Restore persisted session permissions ("Always allow for this session")
      // so grants survive across app restarts. Seed both the renderer store
      // and the main-process cache — the latter is what actually short-circuits
      // permission prompts on the next tool use. Skip if the in-memory store
      // already has entries (a background-running conversation stays authoritative).
      if (stateForUsage.sessionPermissions.length === 0 && conversation.sessionPermissions?.length) {
        chatStore.updateSessionPermissions(id, conversation.sessionPermissions);
        try {
          await window.electron.claude.seedSessionPermissions(id, conversation.sessionPermissions);
        } catch (err) {
          logger.warn('Failed to seed main-process session permissions', { id, err });
        }
      }

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

    // Save current conversation before switching (if it has messages).
    //
    // What follows replaces the message list, so this save is the last chance
    // for anything since the previous one. It is allowed to fail — the disk
    // is not ours to command — but it is not allowed to fail silently: a save
    // that did not land leaves its history retained in the conversation's
    // buffer (see retainUnsavedMessages), which is what the next visit reads
    // in preference to the older file.
    const leaving = currentConversationId.value;
    if (leaving && chatStore.messages.length > 0) {
      const saved = await saveCurrentConversation().catch((err) => {
        logger.error('Failed to save conversation before switch', err);
        return false;
      });
      if (!saved) {
        logger.error('Switching away from a conversation that was not saved', {
          id: leaving,
          messageCount: chatStore.messages.length,
          retained: chatStore.getBufferedMessages(leaving)?.length ?? 0,
        });
      }
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

    // Stamp the execution mode the first time this conversation is saved so
    // future loads can detect mode switches. Once set we never overwrite —
    // conversations stay anchored to the mode that created them.
    const settingsStore = useSettingsStore();
    const executionMode = existingConv?.executionMode ?? settingsStore.executionMode;

    // Snapshot the latest session usage (context tokens, cost, per-model
    // breakdown) so the usage bar can render immediately when this conversation
    // is reopened after an app restart, instead of staying blank until a new
    // query repopulates it. Falls back to whatever was previously persisted
    // if the chat store has no in-memory usage for this conversation yet
    // (e.g. saving a conversation switched away from).
    const inMemoryUsage = chatStore.getConversationState(conversationId).sessionUsage;
    const lastSessionUsage = inMemoryUsage
      ? (JSON.parse(JSON.stringify(inMemoryUsage)) as typeof inMemoryUsage)
      : existingConv?.lastSessionUsage;

    // Persist session-scoped permissions per-conversation so grants survive
    // app restarts. Fall back to whatever was previously persisted for a
    // conversation the user hasn't opened yet in this session.
    const inMemoryPermissions = chatStore.getConversationState(conversationId).sessionPermissions;
    const sessionPermissions = inMemoryPermissions.length > 0
      ? (JSON.parse(JSON.stringify(inMemoryPermissions)) as typeof inMemoryPermissions)
      : existingConv?.sessionPermissions;

    return {
      id: conversationId,
      title,
      customTitle: existingConv?.customTitle,
      // A conversation is pinned to the directory its session was created in:
      // the CLI keys session files by a CWD-derived path
      // (~/.claude/projects/<slugified-cwd>/<session-id>.jsonl), so resuming
      // under a different directory would not find them and the context would
      // be lost. Before there is a session there is nothing to pin to, so the
      // current directory wins — otherwise a conversation whose session has
      // gone would keep claiming the old directory while actually running in
      // the new one.
      workingDirectory: sdkSessionId
        ? (existingConv?.workingDirectory || workingDirectory)
        : workingDirectory,
      messages: rawMessages,
      createdAt: existingConv?.createdAt || Date.now(),
      updatedAt: lastMessageAt,
      sdkSessionId,
      executionMode,
      ...(lastSessionUsage ? { lastSessionUsage } : {}),
      ...(sessionPermissions && sessionPermissions.length > 0 ? { sessionPermissions } : {}),
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
  /**
   * The save currently writing, and at most one follow-up behind it.
   *
   * A save requested while another was in flight used to return immediately
   * having done nothing, and nothing retried it. That is not merely a skipped
   * duplicate: `buildConversationPayload` clones the message array
   * synchronously, so the write already running carries the conversation as it
   * was when IT started and can never include anything newer. Dropping the
   * second request leaves everything since that snapshot in memory only — and
   * `switchConversation` awaits the save and then replaces the message list,
   * so the loss became permanent at exactly the moment the user navigated
   * away. Saves run at the end of every turn and immediately before a switch,
   * so "already saving" is the normal state at that moment.
   *
   * One follow-up is enough however many requests arrive: each save snapshots
   * when it runs, so a single later write covers everything, which is what the
   * old guard was reaching for. The difference is that this one actually
   * happens, and its promise does not resolve until the write has.
   */
  let saveWriting: Promise<boolean> | null = null;
  /** Snapshots waiting to be written, newest per conversation, in order. */
  const saveQueue = new Map<string, Conversation>();

  /**
   * Save the conversation on screen — bound to THAT conversation, now.
   *
   * The payload is built synchronously, before anything can be awaited. The
   * first version of this queue deferred the question and resolved both the
   * conversation id and its messages when the write finally ran, with a
   * comment claiming that was the right moment to ask. It is the right moment
   * to ask whether there is anything to save; it is the wrong moment to ask
   * WHICH conversation, because by then the user may be in another one. A save
   * requested for the conversation they were reading would then write the one
   * they had moved to, and the turn it was asked to save was never written at
   * all — which is a message-loss bug of exactly the kind this queue was added
   * to fix.
   *
   * Keyed by conversation, so a newer snapshot replaces an older one for the
   * same conversation (the newer is a superset) while a save for a different
   * conversation still happens rather than being coalesced away.
   */
  function saveCurrentConversation(): Promise<boolean> {
    const conversationId = currentConversationId.value;
    if (!conversationId) {
      logger.debug('No current conversation ID, skipping save');
      return Promise.resolve(false);
    }
    if (chatStore.messages.length === 0) {
      logger.debug('No messages to save');
      return Promise.resolve(false);
    }

    const settingsStore = useSettingsStore();
    if (!settingsStore.workingDirectory) {
      logger.warn('Cannot save conversation: working directory not set');
      error.value = 'Cannot save conversation: working directory not set';
      // Nothing was written, so the same rule applies as to a failed write:
      // do not let the switch that is about to follow drop the only copy.
      chatStore.retainUnsavedMessages(conversationId, chatStore.messages);
      return Promise.resolve(false);
    }

    saveQueue.set(
      conversationId,
      buildConversationPayload(conversationId, chatStore.messages, settingsStore.workingDirectory),
    );
    return drainSaveQueue();
  }

  /**
   * Write everything queued, one at a time.
   *
   * Serialised so two writes to the same file cannot interleave, and so a
   * caller awaiting a save knows the bytes are down before it continues —
   * `switchConversation` replaces the message list immediately afterwards.
   */
  function drainSaveQueue(): Promise<boolean> {
    if (saveWriting) return saveWriting;

    saveWriting = (async () => {
      let ok = true;
      isSaving.value = true;
      error.value = null;
      try {
        while (saveQueue.size > 0) {
          const [id, conversation] = saveQueue.entries().next().value as [string, Conversation];
          saveQueue.delete(id);
          try {
            await executeSave(conversation, { useTimeout: true, logPrefix: '' });
            logger.info('Conversation saved successfully', {
              id: conversation.id,
              messageCount: conversation.messages.length,
            });
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            logger.error('Failed to save conversation', { error: errorMessage, conversationId: id });
            error.value = `Failed to save conversation: ${errorMessage}`;
            // These messages are now in memory only, and the caller that
            // awaited this save is very often about to replace the list
            // holding them. Keep them reachable; see retainUnsavedMessages.
            chatStore.retainUnsavedMessages(id, conversation.messages);
            ok = false;
          }
        }
      } finally {
        isSaving.value = false;
        saveWriting = null;
      }
      return ok;
    })();

    return saveWriting;
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
      chatStore.retainUnsavedMessages(conversationId, messages);
      return false;
    }

    // Through the same queue as the on-screen save. Both can target the same
    // file — a turn ending just as the user arrives in that conversation —
    // and two interleaved writes to one JSON file is not a race worth
    // leaving open. Snapshotted here, for this conversation, for the same
    // reason the other one is.
    saveQueue.set(
      conversationId,
      buildConversationPayload(conversationId, messages, settingsStore.workingDirectory),
    );
    return drainSaveQueue();
  }

  /**
   * Create a new conversation and make it current
   */
  function createNewConversation(): string {
    // Save what is on screen before discarding it.
    //
    // This cleared the message list outright, so anything added since the last
    // completed save was gone — and unlike a conversation switch, nothing here
    // saved first. Not awaited, and it does not need to be: the save snapshots
    // the message array synchronously, before its first await, so the clear
    // below cannot race it. The write itself finishes through the save queue.
    if (currentConversationId.value && chatStore.messages.length > 0) {
      void saveCurrentConversation().catch((err) => {
        logger.error('Failed to save conversation before starting a new one', err);
      });
    }

    // Generate new conversation ID
    const id = generateId(ID_PREFIXES.CONVERSATION);

    // Switch BEFORE clearing, not after.
    //
    // Clearing while the outgoing conversation was still the current one gave
    // it an empty on-screen list to call its own: a turn still collecting in
    // its buffer shares that array while the conversation is in view, so the
    // clear took its history with it and the rest of the turn appended to
    // nothing. Switching first detaches that buffer with the history intact,
    // and the clear then applies to the new conversation, which has none.
    currentConversationId.value = id;
    chatStore.setCurrentConversation(id);

    // Clear current chat messages
    chatStore.clearMessages();

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

      // And the remembered scroll position, which is view state and so is not
      // part of that.
      forgetPosition(id);

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
   * Get the stored working directory for a conversation.
   * Used to pass the correct CWD when resuming a session — the CLI looks for
   * session files under a CWD-derived path, so it must match the original.
   */
  function getConversationWorkingDirectory(conversationId: string): string | undefined {
    const conv = conversations.value.find((c: Conversation) => c.id === conversationId);
    return conv?.workingDirectory || undefined;
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
   * Acknowledge a mode mismatch on the current conversation: re-stamp the
   * conversation with the user's current execution mode and drop the stored
   * SDK session ID so the next send starts fresh in the new mode.
   */
  async function adoptCurrentExecutionMode(): Promise<void> {
    if (!currentConversationId.value) return;
    const settingsStore = useSettingsStore();
    const conv = conversations.value.find(
      (c: Conversation) => c.id === currentConversationId.value,
    );
    if (!conv) return;

    conv.executionMode = settingsStore.executionMode;
    clearCurrentSdkSessionId();

    logger.info('Adopted current execution mode for conversation', {
      conversationId: currentConversationId.value,
      newMode: settingsStore.executionMode,
    });

    // Persist the mode change so future loads reflect it
    if (chatStore.messages.length > 0) {
      await saveCurrentConversation().catch((err) => {
        logger.warn('Failed to persist adopted execution mode', { error: err });
      });
    }
  }

  /**
   * Clear ALL stored SDK session IDs.
   * Used when authentication changes (re-login, migration) to prevent
   * stale session resume attempts with a different auth context.
   */
  function clearAllSdkSessionIds(): void {
    const count = sdkSessionIds.value.size;
    sdkSessionIds.value.clear();
    if (count > 0) {
      logger.info('Cleared all SDK session IDs after auth change', { count });
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

    // And every conversation still collecting a turn out of sight.
    //
    // Only the conversation on screen was saved here, so a turn running in
    // another one lost everything since its last save: its buffer is written
    // to disk when the turn ends, and closing the app means that never
    // happens. Saved one at a time, and independently, so one failure does
    // not take the others down with it.
    for (const id of chatStore.bufferingConversationIds()) {
      if (id === currentConversationId.value) continue;
      const buffered = chatStore.getBufferedMessages(id);
      if (!buffered || buffered.length === 0) continue;
      try {
        await saveConversation(id, buffered);
      } catch (err) {
        logger.error('Failed to save background conversation during cleanup', { id, err });
      }
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
    currentModeMismatch,

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
    getConversationWorkingDirectory,
    clearSdkSessionId,
    clearCurrentSdkSessionId,
    clearAllSdkSessionIds,
    currentConversationHasSession,

    // Execution mode tracking
    adoptCurrentExecutionMode,
  };
});
