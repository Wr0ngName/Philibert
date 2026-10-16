/**
 * Conversations store - manages conversation persistence and history
 * Updated for multi-conversation support
 */

import { defineStore, storeToRefs } from 'pinia';
import { ref, computed, watch } from 'vue';

import type { ChatMessage, Conversation, ConversationUpdate } from '@shared/types';

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
      // Only the tail, plus how much is older. A conversation is not read
      // whole: nothing bounded the loaded list before, so a long one sat in
      // memory in full for as long as the app ran.
      const window_ = await window.electron.conversation.getWindow(
        id,
        CONSTANTS.CONVERSATION.WINDOW_SIZE,
      );
      if (!window_) {
        error.value = 'Conversation not found';
        return false;
      }
      const conversation = window_.conversation;
      const olderCount = window_.olderCount;

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

        // The buffer is seeded from what was on screen, which is a WINDOW of
        // the conversation and not the whole of it — so its accounting comes
        // back with it. Restoring the list while letting the counts default
        // said "this is the entire conversation" about a window that could
        // stop thousands of messages short at either end: nothing said
        // otherwise, and the badge that was the only way to the rest of it
        // was gone.
        chatStore.loadMessages(messages, state.olderCount, state.newerCount);
      } else {
        // Load messages from saved file
        chatStore.loadMessages(conversation.messages, olderCount);

        // A turn collected apart from a window that fell short of the end is
        // not in the file yet, and this window IS the end of the file — so
        // that turn is what comes next and belongs on it. Without this, a
        // reader who stepped out mid-turn came back to a window read fresh
        // off disk with the turn they were waiting on nowhere in it.
        chatStore.absorbDetachedTurn(id);

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

      // Put the model's task list back. The saved list is exact; replaying the
      // Task* calls out of the transcript is the fallback for conversations
      // saved before it was persisted, and is close rather than exact (see
      // `rebuildTaskList`). Either way this is a no-op for a conversation
      // whose list is already live in memory.
      if (!chatStore.restoreTaskList(id, conversation.taskList)) {
        chatStore.rebuildTaskList(id, chatStore.messages);
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
    // Something to add, something to remove, or something held apart from the
    // window — any of the three is a reason to write before leaving. Guarding
    // on the on-screen list alone meant a rewind that emptied it was never
    // written: the file kept every message and the next visit showed them all
    // again.
    const leavingHasWork = !!leaving && (
      chatStore.messages.length > 0
      || !!chatStore.pendingTruncationFor(leaving)
      || !!chatStore.detachedTurnFor(leaving)
    );
    if (leaving && leavingHasWork) {
      const saved = await saveCurrentConversation().catch((err) => {
        logger.error('Failed to save conversation before switch', err);
        return false;
      });
      if (!saved) {
        logger.error('Switching away from a conversation that was not saved', {
          id: leaving,
          messageCount: chatStore.messages.length,
          retained: chatStore.unwrittenMessagesFor(leaving)?.length ?? 0,
        });
      }
    }

    // Load the target conversation
    return loadConversation(id);
  }

  /**
   * Build the write for a conversation: its metadata, and the messages the
   * renderer holds, to be added or replaced by id.
   *
   * The messages are the WINDOW, not the conversation — so this cannot be a
   * full write. See ConversationUpdate: a write carrying the whole list makes
   * the file only as complete as memory, which is what made bounding memory
   * unsafe.
   *
   * The title is only ever sent when the window is the whole conversation.
   * Generated from the first user message, and with a window the first
   * message in memory is not the conversation's first — the main process
   * keeps the stored title, and fills an empty one from the merged history.
   */
  function buildConversationUpdate(
    conversationId: string,
    messages: ChatMessage[],
    workingDirectory: string,
  ): ConversationUpdate {
    // A rewind removed turns on screen; a write has to say so or they stay in
    // the file. Read here, cleared only once the write has landed.
    const truncation = chatStore.pendingTruncationFor(conversationId);
    const options = truncation ? { truncateFromId: truncation.fromId } : {};
    // Deep clone messages to strip ALL Vue reactivity (including nested objects)
    // Vue proxies can't be cloned across IPC - use JSON round-trip for complete deproxification
    const rawMessages: ChatMessage[] = JSON.parse(JSON.stringify(messages));
    const existingConv = conversations.value.find((c: Conversation) => c.id === conversationId);

    // Only when the window is the whole conversation; see above.
    const holdsWholeHistory = chatStore.getConversationState(conversationId).olderCount === 0;
    const generatedTitle = holdsWholeHistory ? generateTitle(messages) : undefined;
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

    // The model's task list, so a restart resumes on the same list rather
    // than an empty panel. Falls back to whatever was saved before for the
    // same reason as the two above: a conversation can be saved while its
    // state is not loaded, and writing an empty list over a real one would
    // destroy it.
    const inMemoryTaskList = chatStore.getTaskListItems(conversationId);
    const taskList = inMemoryTaskList.length > 0 ? inMemoryTaskList : existingConv?.taskList;

    return {
      id: conversationId,
      ...(title !== undefined ? { title } : {}),
      ...(existingConv?.customTitle !== undefined ? { customTitle: existingConv.customTitle } : {}),
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
      upsert: rawMessages,
      ...(options.truncateFromId ? { truncateFromId: options.truncateFromId } : {}),
      createdAt: existingConv?.createdAt || Date.now(),
      updatedAt: lastMessageAt,
      sdkSessionId,
      executionMode,
      ...(lastSessionUsage ? { lastSessionUsage } : {}),
      ...(sessionPermissions && sessionPermissions.length > 0 ? { sessionPermissions } : {}),
      ...(taskList && taskList.length > 0 ? { taskList } : {}),
    };
  }

  /**
   * Update the conversations list after a successful save.
   */
  /**
   * Reflect a write in the sidebar list.
   *
   * Built from the update rather than from a whole conversation, because a
   * write no longer carries one. The list only ever shows metadata — it has
   * always been stored with `messages: []` — so nothing is lost by that; an
   * entry that already exists keeps the fields this update did not mention.
   */
  function updateConversationList(update: ConversationUpdate): void {
    const index = conversations.value.findIndex((c: Conversation) => c.id === update.id);
    const existing = index !== -1 ? conversations.value[index] : undefined;

    const listEntry: Conversation = {
      ...(existing ?? {
        id: update.id,
        title: '',
        workingDirectory: update.workingDirectory,
        createdAt: update.createdAt ?? Date.now(),
      } as Conversation),
      id: update.id,
      messages: [],
      workingDirectory: update.workingDirectory || existing?.workingDirectory || '',
      updatedAt: update.updatedAt,
      ...(update.title !== undefined ? { title: update.title } : {}),
      ...(update.customTitle !== undefined ? { customTitle: update.customTitle } : {}),
      ...(update.sdkSessionId !== undefined ? { sdkSessionId: update.sdkSessionId } : {}),
      ...(update.executionMode !== undefined ? { executionMode: update.executionMode } : {}),
      ...(update.lastSessionUsage !== undefined ? { lastSessionUsage: update.lastSessionUsage } : {}),
      ...(update.sessionPermissions !== undefined ? { sessionPermissions: update.sessionPermissions } : {}),
      ...(update.taskList !== undefined ? { taskList: update.taskList } : {}),
    };

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
    update: ConversationUpdate,
    options: { useTimeout: boolean; logPrefix: string }
  ): Promise<void> {
    logger.info(`Saving conversation${options.logPrefix}`, {
      id: update.id,
      upsertCount: update.upsert.length,
      truncating: update.truncateFromId ?? 'none',
      title: update.title?.slice(0, 30),
    });

    if (options.useTimeout) {
      const savePromise = window.electron.conversation.update(update);
      const timeoutMs = CONSTANTS.CONVERSATION.SAVE_TIMEOUT_MS;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Save operation timed out after ${timeoutMs / 1000} seconds`)), timeoutMs);
      });
      await Promise.race([savePromise, timeoutPromise]);
    } else {
      await window.electron.conversation.update(update);
    }

    updateConversationList(update);
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
   * duplicate: `buildConversationUpdate` clones the message array
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
  /**
   * Forget the oldest messages of a conversation whose write has landed.
   *
   * The only safe moment to trim: what is being dropped is on disk, and a
   * write can no longer shorten the file (see ConversationUpdate), so the
   * window is free to be smaller than the conversation. Left alone until it
   * grows past WINDOW_MAX so a long turn is never trimmed mid-arrival.
   */
  function trimAfterSave(conversationId: string): void {
    const onScreen = conversationId === currentConversationId.value;
    const held = onScreen
      ? chatStore.messages.length
      : chatStore.getBufferedMessages(conversationId)?.length ?? 0;
    if (held <= CONSTANTS.CONVERSATION.WINDOW_MAX) return;

    // Trimming removes rows above the viewport. At the tail that is
    // invisible; to someone scrolled back reading history it would yank the
    // page forward by the height of everything dropped. So a conversation
    // being read keeps its window until its view returns to the tail — which
    // costs memory only while the user is actually looking at the past.
    if (onScreen && !chatStore.isTailPinned(conversationId)) {
      logger.debug('Not trimming: the view is reading history', { id: conversationId, held });
      return;
    }

    const dropped = chatStore.trimWindow(conversationId, CONSTANTS.CONVERSATION.WINDOW_SIZE);
    if (dropped > 0) {
      logger.info('Trimmed saved messages out of memory', {
        id: conversationId,
        dropped,
        held: held - dropped,
      });
    }
  }

  let saveWriting: Promise<boolean> | null = null;
  /** Writes waiting to go out, newest per conversation, in order. */
  const saveQueue = new Map<string, ConversationUpdate>();
  /** True while a page of earlier messages is being fetched. */
  const loadingEarlier = ref(false);
  /** True while a page of newer messages is being fetched. */
  const loadingNewer = ref(false);

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
    // Nothing to add AND nothing to remove. A rewind to the oldest turn on
    // screen empties the list, and skipping the write for that reason meant
    // the rewind never reached disk at all: the transcript went blank, the
    // file kept every message, and reopening the conversation brought all of
    // it back.
    if (chatStore.messages.length === 0 && !chatStore.pendingTruncationFor(conversationId)) {
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

    // What to write: the window, or — when the window does not reach the end
    // of the conversation — only the turn that was collected apart from it.
    //
    // This is the whole point of a write being an upsert. It adds and
    // replaces by id and never shortens the file, so a payload of just what
    // changed is exactly what the contract was built for; and because the
    // save no longer has to be handed the window, the window no longer has to
    // contain everything that needs saving. That was what forced an arriving
    // turn into a list it did not belong to.
    const detached = chatStore.detachedTurnFor(conversationId);
    saveQueue.set(
      conversationId,
      buildConversationUpdate(
        conversationId,
        detached ?? chatStore.messages,
        settingsStore.workingDirectory,
      ),
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
          const [id, conversation] = saveQueue.entries().next().value as [string, ConversationUpdate];
          saveQueue.delete(id);
          try {
            await executeSave(conversation, { useTimeout: true, logPrefix: '' });
            logger.info('Conversation saved successfully', {
              id: conversation.id,
              upsertCount: conversation.upsert.length,
            });
            // The write landed: a removal it carried has reached the file,
            // and everything written is now on disk, so the window may be
            // trimmed back — the only moment at which forgetting part of a
            // conversation is safe.
            if (conversation.truncateFromId) {
              chatStore.clearPendingTruncation(id);
            }
            // A turn collected apart from the window is stored now, so it is
            // simply what follows the window — which is what the "newer
            // messages" count means. Held no longer.
            chatStore.detachedTurnStored(id);
            trimAfterSave(id);
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            logger.error('Failed to save conversation', { error: errorMessage, conversationId: id });
            error.value = `Failed to save conversation: ${errorMessage}`;
            // These messages are now in memory only, and the caller that
            // awaited this save is very often about to replace the list
            // holding them. Keep them reachable; see retainUnsavedMessages.
            chatStore.retainUnsavedMessages(id, conversation.upsert);
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
      buildConversationUpdate(conversationId, messages, settingsStore.workingDirectory),
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
   * Fetch the page of messages before the window and put it on screen.
   *
   * Keyed by the id currently at the top rather than by an offset, so a turn
   * landing in between cannot shift the page. Returns how many messages
   * arrived — 0 when there was nothing older, or when the request failed and
   * the user can try again.
   */
  async function loadEarlierMessages(): Promise<number> {
    const id = currentConversationId.value;
    if (!id) return 0;
    if (chatStore.olderMessageCount === 0) return 0;

    const top = chatStore.messages[0];
    if (!top) return 0;

    if (loadingEarlier.value) return 0;
    loadingEarlier.value = true;
    try {
      const page = await window.electron.conversation.getOlder(
        id,
        top.id,
        CONSTANTS.CONVERSATION.WINDOW_SIZE,
      );
      if (!page) return 0;

      // The conversation may have been switched away from while this was in
      // flight; those messages belong to a list that is no longer on screen.
      if (currentConversationId.value !== id) return 0;

      // Or it may be the same conversation showing a different stretch of
      // itself: the reader jumped to the end, or reopened it. The page was
      // computed to sit in front of `top`, and in front of anything else it
      // is simply wrong — measured, it produced a window running msg_1000 to
      // msg_1499 followed by msg_3500, with a two-thousand-message hole in
      // the middle and nothing to say so.
      if (chatStore.messages[0]?.id !== top.id) {
        logger.info('Discarded a page of history: the window moved while it was read', {
          id, anchor: top.id, now: chatStore.messages[0]?.id,
        });
        return 0;
      }

      chatStore.prependOlderMessages(id, page.messages, page.olderCount);
      logger.info('Loaded earlier messages', {
        id,
        loaded: page.messages.length,
        stillOlder: page.olderCount,
      });
      return page.messages.length;
    } catch (err) {
      logger.error('Failed to load earlier messages', { id, err });
      error.value = 'Could not load earlier messages';
      return 0;
    } finally {
      loadingEarlier.value = false;
    }
  }

  /**
   * Fetch the page after the window and put it on screen.
   *
   * The way back down: reading far enough back unloads the newest messages,
   * and this is how they return. Keyed by the id at the bottom of the window
   * for the same reason the other direction is keyed by the id at the top.
   */
  async function loadNewerMessages(): Promise<number> {
    const id = currentConversationId.value;
    if (!id) return 0;
    if (chatStore.newerMessageCount === 0) return 0;

    // The end of the window, which is always the end of one unbroken range
    // of the conversation — a turn that arrived while the window fell short
    // of the end is held apart from it, not stitched onto it.
    const from = chatStore.messages[chatStore.messages.length - 1]?.id;
    if (!from) return 0;
    if (loadingNewer.value) return 0;

    loadingNewer.value = true;
    try {
      const page = await window.electron.conversation.getNewer(
        id, from, CONSTANTS.CONVERSATION.WINDOW_SIZE,
      );
      if (!page) return 0;
      // Switched away while this was in flight.
      if (currentConversationId.value !== id) return 0;

      // Or the same conversation moved to a different stretch of itself. The
      // page belongs after `from` and nowhere else — measured, appending it
      // regardless put msg_901 after msg_3999.
      if (chatStore.messages[chatStore.messages.length - 1]?.id !== from) {
        logger.info('Discarded a page of the tail: the window moved while it was read', {
          id, anchor: from, now: chatStore.messages[chatStore.messages.length - 1]?.id,
        });
        return 0;
      }

      chatStore.appendNewerMessages(id, page.messages, page.newerCount);
      logger.info('Loaded newer messages', {
        id, loaded: page.messages.length, stillNewer: page.newerCount,
      });
      return page.messages.length;
    } catch (err) {
      logger.error('Failed to load newer messages', { id, err });
      error.value = 'Could not load newer messages';
      return 0;
    } finally {
      loadingNewer.value = false;
    }
  }

  /**
   * Reload the window at the end of the conversation.
   *
   * What "go to the newest message" has to mean once the tail has been
   * unloaded: scrolling cannot reach a message that is not loaded.
   */
  async function jumpToLatest(): Promise<boolean> {
    const id = currentConversationId.value;
    if (!id) return false;
    if (chatStore.newerMessageCount === 0) return true;

    try {
      const latest = await window.electron.conversation.getWindow(
        id, CONSTANTS.CONVERSATION.WINDOW_SIZE,
      );
      if (!latest) return false;
      if (currentConversationId.value !== id) return false;

      chatStore.loadMessages(latest.conversation.messages, latest.olderCount, 0);
      // A turn written while the window fell short of the end may not be
      // stored yet — the write lands when the turn ends — and the loaded
      // window replaces the message list outright. The window now reaches the
      // end, so that turn belongs on it: without this, jumping to the end
      // would destroy the very messages it was meant to reveal.
      chatStore.absorbDetachedTurn(id);
      logger.info('Jumped to the end of the conversation', {
        id,
        held: chatStore.messages.length,
        older: latest.olderCount,
      });
      return true;
    } catch (err) {
      logger.error('Failed to jump to the latest messages', { id, err });
      error.value = 'Could not load the newest messages';
      return false;
    }
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

    // And every conversation holding anything that is not on disk.
    //
    // Only the conversation on screen was saved here, so a turn running in
    // another one lost everything since its last save: it is written when the
    // turn ends, and closing the app means that never happens. Saved one at a
    // time, and independently, so one failure does not take the others down
    // with it.
    //
    // "Holding anything" rather than "buffering": a conversation whose window
    // falls short of the end keeps its turn in `detachedTurn` and has no
    // buffer at all, so asking only about buffers let its turn die with the
    // process.
    for (const id of chatStore.conversationIdsWithUnwrittenMessages()) {
      if (id === currentConversationId.value) continue;
      const unwritten = chatStore.unwrittenMessagesFor(id);
      if (!unwritten || unwritten.length === 0) continue;
      try {
        await saveConversation(id, unwritten);
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
    loadEarlierMessages,
    loadNewerMessages,
    jumpToLatest,
    loadingEarlier,
    loadingNewer,
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
