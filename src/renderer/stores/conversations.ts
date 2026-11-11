/**
 * Conversations store - manages conversation persistence and history
 * Updated for multi-conversation support
 */

import { defineStore, storeToRefs } from 'pinia';
import { ref, computed, watch } from 'vue';

import { isAfter, isArchived, newestFirst } from '@shared/conversation-list';
import { titleFromMessages } from '@shared/conversation-title';
import type {
  AutoArchiveDays,
  ChatMessage,
  Conversation,
  ConversationListCursor,
  ConversationSummary,
  ConversationUpdate,
  ConversationWindow,
} from '@shared/types';

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
  /**
   * The discussion being opened, until its messages are read: the first
   * opening of a long one in a session reads its whole file, which takes
   * seconds, and the list says so meanwhile (MessageListSource.opening).
   */
  const openingConversationId = ref<string | null>(null);
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

  /**
   * The discussions list: the active ones or the archived ones, loaded a page
   * at a time as it is scrolled. `conversations` also holds discussions
   * opened from elsewhere — search, the last one at start — so the list is
   * those of the view, cut where the pages loaded so far end: one older than
   * that appears when its page does, in its place.
   */
  const listView = ref<'active' | 'archived'>('active');
  /** The last entry of the pages loaded, or null before the first. */
  const listCursor = ref<ConversationListCursor | null>(null);
  const listHasMore = ref(false);
  const loadingMoreConversations = ref(false);
  /** How many discussions are archived, by hand or for being inactive. */
  const archivedCount = ref(0);
  /** Pages asked for with an older request than this are dropped: the list was reloaded since. */
  let listGeneration = 0;

  function autoArchiveDays(): AutoArchiveDays {
    return useSettingsStore().config.autoArchiveDays;
  }

  // The setting decides which discussions are archived, so the list is read
  // again when it changes — and when the saved settings arrive after the
  // first page was read with the default. Not before that first page: the
  // list is not shown until initialize has read it.
  watch(autoArchiveDays, () => {
    if (listGeneration === 0) return;
    listCursor.value = null;
    listHasMore.value = false;
    void loadConversationList();
  });

  function inArchive(conversation: Conversation, now = Date.now()): boolean {
    return isArchived(conversation, autoArchiveDays(), now);
  }

  /**
   * Whether a held discussion is archived: nothing can be written in it until
   * it is brought back. One not held is not known to be.
   */
  function isConversationArchived(id: string): boolean {
    const conversation = conversations.value.find((c) => c.id === id);
    return conversation !== undefined && inArchive(conversation);
  }

  /** The open discussion, when it is archived; see isConversationArchived. */
  const currentArchived = computed((): Conversation | null => {
    const conversation = currentConversation.value;
    return conversation && inArchive(conversation) ? conversation : null;
  });

  const listedConversations = computed(() => {
    const now = Date.now();
    const archived = listView.value === 'archived';
    const cursor = listCursor.value;
    return conversations.value
      .filter((c) => inArchive(c, now) === archived)
      // The open one is listed in its place even when its page is not loaded
      // yet — opened from search, or at start — so it is always in sight.
      .filter((c) => !listHasMore.value || !cursor || !isAfter(c, cursor) || c.id === currentConversationId.value)
      .sort(newestFirst);
  });

  /** The last discussion "New conversation" started; see newDiscussionRow. */
  const startedConversationId = ref<string | null>(null);

  /**
   * The row of a discussion just started and not saved yet: the open one,
   * listed (in the active list) before anything is typed, so the list shows
   * where the user is. It becomes the discussion's own row once it is saved,
   * and is gone once another one is opened — nothing is written for it.
   */
  const newDiscussionRow = computed((): { id: string; workingDirectory: string } | null => {
    const id = currentConversationId.value;
    if (!id || id !== startedConversationId.value || listView.value !== 'active') return null;
    if (conversations.value.some((c) => c.id === id)) return null;
    return { id, workingDirectory: useSettingsStore().workingDirectory };
  });

  /**
   * Counts the times the list was brought to the open conversation, for the
   * list to show its row: once its pages are loaded, and only then — showing
   * it earlier, at the end of what was loaded, brought the end of the list
   * into reach and loaded a page above it, pushing it away again.
   */
  const listRevealCount = ref(0);

  /**
   * Bring the list to an opened conversation: the list it belongs to — one
   * opened from search or at start may be archived while the active list is
   * shown, or the reverse — loaded down to its page, so its row is in its
   * place among the others. Its row is where the user sees which one is open.
   */
  async function followInList(conversation: Conversation): Promise<void> {
    const view = inArchive(conversation) ? 'archived' : 'active';
    if (listView.value !== view) await showListView(view);
    const stillOpen = () => currentConversationId.value === conversation.id;
    while (stillOpen() && listHasMore.value && listCursor.value && isAfter(conversation, listCursor.value)) {
      const before = listCursor.value;
      await loadMoreConversations();
      // A page that did not come — a failure, or one already being loaded
      // as the user scrolls — ends it here rather than asking again.
      if (listCursor.value === before) break;
    }
    if (stillOpen()) listRevealCount.value += 1;
  }

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
   * Put list entries into `conversations`. An entry already held keeps what
   * the list does not carry — the messages and session state of one that is
   * open.
   */
  function mergeSummaries(summaries: ConversationSummary[]): void {
    // Migration: stamp the current execution mode onto any conversation that
    // doesn't already have one. We do this in memory only; the file gets
    // updated on the next save. This preserves the user's expectation that
    // pre-existing conversations "belong to" whatever mode they're currently
    // in, while keeping any newly created conversation anchored to its
    // creation mode for future mode-switch detection.
    const currentMode = useSettingsStore().executionMode;
    const indexById = new Map(conversations.value.map((c, index) => [c.id, index]));
    for (const summary of summaries) {
      const at = indexById.get(summary.id);
      if (at !== undefined) {
        // The entry is what the disk says: a field it leaves out is not set
        // there — an archive mark removed when the discussion was brought
        // back must go here too. The execution mode stamped above stays.
        const kept: Conversation = { ...conversations.value[at] };
        delete kept.customTitle;
        delete kept.archivedAt;
        delete kept.restoredAt;
        delete kept.sessionGone;
        conversations.value[at] = { ...kept, ...summary, executionMode: summary.executionMode ?? kept.executionMode };
      } else {
        indexById.set(summary.id, conversations.value.length);
        conversations.value.push({
          ...summary,
          executionMode: summary.executionMode ?? currentMode,
          messages: [],
        });
      }
    }
  }

  /** Ask again how many discussions are archived. */
  async function refreshArchivedCount(): Promise<void> {
    try {
      archivedCount.value = await window.electron.conversation.archivedCount(autoArchiveDays());
    } catch (err) {
      logger.warn('Failed to count archived conversations', { error: err });
    }
  }

  /**
   * Load the first page of the list shown — active or archived — and the
   * archived count. The pages after it come with loadMoreConversations.
   */
  async function loadConversationList(): Promise<void> {
    const generation = ++listGeneration;
    isLoading.value = true;
    error.value = null;
    try {
      const page = await window.electron.conversation.listPage({
        archived: listView.value === 'archived',
        autoArchiveDays: autoArchiveDays(),
        limit: CONSTANTS.CONVERSATION.LIST_PAGE_SIZE,
      });
      if (generation !== listGeneration) return;
      // Read afresh: what is not on this page comes back with its own page,
      // and what is gone from the disk goes from the list. Only what is held
      // stays regardless — the conversation on screen, and those still at
      // work in the background, which their turns read from here.
      conversations.value = conversations.value.filter(
        (c) =>
          c.id === currentConversationId.value ||
          chatStore.isConversationLoading(c.id) ||
          chatStore.conversationHasPendingActions(c.id),
      );
      mergeSummaries(page.conversations);
      listCursor.value = page.conversations.at(-1) ?? null;
      listHasMore.value = page.hasMore;
      logger.debug('Loaded conversation list', { view: listView.value, count: page.conversations.length, hasMore: page.hasMore });
    } catch (err) {
      logger.error('Failed to load conversations', err);
      error.value = 'Failed to load conversations';
    } finally {
      if (generation === listGeneration) isLoading.value = false;
    }
    await refreshArchivedCount();
  }

  /** The next page of the list shown, when there is one and none is loading. */
  async function loadMoreConversations(): Promise<void> {
    const cursor = listCursor.value;
    if (!listHasMore.value || !cursor || loadingMoreConversations.value) return;
    const generation = listGeneration;
    loadingMoreConversations.value = true;
    try {
      const page = await window.electron.conversation.listPage({
        archived: listView.value === 'archived',
        autoArchiveDays: autoArchiveDays(),
        after: { updatedAt: cursor.updatedAt, id: cursor.id },
        limit: CONSTANTS.CONVERSATION.LIST_PAGE_SIZE,
      });
      if (generation !== listGeneration) return;
      mergeSummaries(page.conversations);
      listCursor.value = page.conversations.at(-1) ?? cursor;
      listHasMore.value = page.hasMore;
    } catch (err) {
      logger.error('Failed to load more conversations', err);
      error.value = 'Failed to load more conversations';
    } finally {
      loadingMoreConversations.value = false;
    }
  }

  /** Show the active discussions or the archived ones, from their first page. */
  async function showListView(view: 'active' | 'archived'): Promise<void> {
    if (listView.value === view) return;
    listView.value = view;
    listCursor.value = null;
    listHasMore.value = false;
    await loadConversationList();
  }

  /**
   * Archive a discussion, or bring it back. One that is open stays open: it
   * only moves between the lists.
   */
  async function setConversationArchived(id: string, archived: boolean): Promise<boolean> {
    try {
      const summary = await window.electron.conversation.setArchived(id, archived);
      mergeSummaries([summary]);
      if (!archived && summary.sessionGone) {
        // Refused: its session went since the list was read.
        logger.warn('Conversation not brought back: its Claude Code session is gone', { id });
        error.value = "This discussion can't be brought back: Claude's session for it no longer exists";
        return false;
      }
      logger.info(archived ? 'Archived conversation' : 'Brought a conversation back from the archive', { id });
      await refreshArchivedCount();
      return true;
    } catch (err) {
      logger.error('Failed to archive or restore conversation', { id, archived, error: err });
      error.value = archived ? 'Failed to archive the conversation' : 'Failed to bring the conversation back';
      return false;
    }
  }

  /**
   * Load a specific conversation and its messages
   */
  async function loadConversation(id: string): Promise<boolean> {
    isLoading.value = true;
    openingConversationId.value = id;
    error.value = null;

    try {
      // Only the tail, plus how much is older. A conversation is not read
      // whole: nothing bounded the loaded list before, so a long one sat in
      // memory in full for as long as the app ran.
      const window_ = await readWindow(id);
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
      void followInList(conversation);

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

      // Put the model's task list back, as saved — a no-op for a conversation
      // whose list is already live in memory. Without a saved list the panel
      // starts empty: it is not rebuilt from the Task* calls in the history,
      // which cannot give the ids Claude Code assigned and so left tasks
      // without their number, deaf to every update. Claude's own TaskList
      // brings it back (handleTaskListSnapshot).
      chatStore.restoreTaskList(id, conversation.taskList);

      // Update working directory if different
      const settingsStore = useSettingsStore();
      if (conversation.workingDirectory && conversation.workingDirectory !== settingsStore.workingDirectory) {
        await settingsStore.setWorkingDirectory(conversation.workingDirectory);
      }

      // What is known of the conversations left is forgotten with their windows.
      for (const other of [...writtenJson.keys()]) {
        if (other !== id) pruneWritten(other);
      }
      logger.info('Loaded conversation', { id, messageCount: conversation.messages.length });
      return true;
    } catch (err) {
      logger.error('Failed to load conversation', err);
      error.value = 'Failed to load conversation';
      return false;
    } finally {
      isLoading.value = false;
      // Only this opening's own: one started since is still under way.
      if (openingConversationId.value === id) openingConversationId.value = null;
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
   * Each message as last known to be on disk — its JSON — per conversation.
   *
   * A save sent every message the window holds, 500 to 1,500 of them (about
   * 2 MB on a long discussion), deep-copied here and again across IPC, for
   * the main process to find that nearly all were unchanged. Now it sends
   * only those whose JSON differs from this. Compared on the JSON a write
   * would carry, so no way of changing a message can be missed.
   *
   * Known from a write that landed, and from a read of the file. Forgotten
   * when a rewind lands: it removes messages from the file.
   */
  const writtenJson = new Map<string, Map<string, string>>();
  /**
   * Times each conversation's writtenJson was forgotten, so a read begun
   * before a rewind landed cannot record messages the rewind removed.
   */
  const writtenEpochs = new Map<string, number>();

  function writtenEpoch(conversationId: string): number {
    return writtenEpochs.get(conversationId) ?? 0;
  }

  function noteWritten(conversationId: string, entries: Iterable<readonly [string, string]>): void {
    let known = writtenJson.get(conversationId);
    if (!known) {
      known = new Map();
      writtenJson.set(conversationId, known);
    }
    for (const [id, json] of entries) known.set(id, json);
  }

  /** Messages just read from the file: on disk as they are, unless a rewind landed meanwhile. */
  function noteRead(conversationId: string, messages: readonly ChatMessage[], epoch: number): void {
    if (writtenEpoch(conversationId) !== epoch) return;
    noteWritten(conversationId, messages.map((m) => [m.id, JSON.stringify(m)] as const));
    // The page just read is kept: it is about to be held.
    pruneWritten(conversationId, messages.map((m) => m.id));
  }

  /**
   * Forget what is known of messages no longer held — let go of by the
   * window as it is trimmed or slides, or with the whole conversation once
   * it is not in memory. What is known is only ever of messages a save can
   * carry, so it stays as small as the window: kept for every message read,
   * it grew to the whole conversation for a reader scrolling to its start.
   * One read again is known again from that read; one not known is only
   * sent once more by a save, which the main process finds unchanged.
   */
  function pruneWritten(conversationId: string, alsoKeep: Iterable<string> = []): void {
    const known = writtenJson.get(conversationId);
    if (!known) return;
    const held = chatStore.heldMessageIds(conversationId);
    for (const id of alsoKeep) held.add(id);
    if (held.size === 0) {
      writtenJson.delete(conversationId);
      return;
    }
    for (const id of known.keys()) {
      if (!held.has(id)) known.delete(id);
    }
  }

  /** How many messages are known to be on disk as they are, for a conversation; for diagnostics and tests. */
  function writtenRecordCount(conversationId: string): number {
    return writtenJson.get(conversationId)?.size ?? 0;
  }

  function forgetWritten(conversationId: string): void {
    writtenJson.delete(conversationId);
    writtenEpochs.set(conversationId, writtenEpoch(conversationId) + 1);
  }

  /** A read of a conversation's stored messages, which are then known to be on disk (noteRead). */
  async function readStored<T>(
    conversationId: string,
    read: () => Promise<T | null>,
    messagesOf: (result: T) => readonly ChatMessage[],
  ): Promise<T | null> {
    const epoch = writtenEpoch(conversationId);
    const result = await read();
    if (result) noteRead(conversationId, messagesOf(result), epoch);
    return result;
  }

  /** A conversation's tail, the size of a window, and how much is older. */
  function readWindow(conversationId: string): Promise<ConversationWindow | null> {
    return readStored(
      conversationId,
      () => window.electron.conversation.getWindow(conversationId, CONSTANTS.CONVERSATION.WINDOW_SIZE),
      (read) => read.conversation.messages,
    );
  }

  /** A write, with what it means once it lands or fails. */
  interface PendingWrite {
    update: ConversationUpdate;
    /** The JSON of each message it carries, recorded once it lands. */
    written: Array<readonly [string, string]>;
    /** Everything it was built from — kept if it fails; see retainUnsavedMessages. */
    held: ChatMessage[];
  }

  /**
   * Build the write for a conversation: its metadata, and the messages the
   * renderer holds that are not on disk as they are, to be added or
   * replaced by id.
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
  ): PendingWrite {
    // A rewind removed turns on screen; a write has to say so or they stay in
    // the file. Read here, cleared only once the write has landed.
    const truncation = chatStore.pendingTruncationFor(conversationId);
    const options = truncation ? { truncateFromId: truncation.fromId } : {};
    // Task rows are written as their tasks stand now, not as they stood when
    // the row was added.
    const tracked = chatStore.withTasksAsTracked(conversationId, messages);
    // Only what differs from the file — all of it when the write cuts the
    // file, which removes what it held from the cut on. Each sent message is
    // a copy through JSON, which also strips Vue's reactivity: a proxy
    // cannot cross IPC.
    const known = truncation ? undefined : writtenJson.get(conversationId);
    const written: Array<readonly [string, string]> = [];
    const rawMessages: ChatMessage[] = [];
    for (const message of tracked) {
      const json = JSON.stringify(message);
      if (known?.get(message.id) === json) continue;
      written.push([message.id, json]);
      rawMessages.push(JSON.parse(json) as ChatMessage);
    }
    const existingConv = conversations.value.find((c: Conversation) => c.id === conversationId);

    // Only when the window is the whole conversation; see above.
    const holdsWholeHistory = chatStore.getConversationState(conversationId).olderCount === 0;
    const generatedTitle = holdsWholeHistory ? generateTitle(messages) : undefined;
    const title = existingConv?.customTitle ? existingConv.title : generatedTitle;

    // Get SDK session ID from in-memory map (for persistence)
    const sdkSessionId = sdkSessionIds.value.get(conversationId);

    // Use last message timestamp for ordering (so history sorts by last message, not last access)
    const lastMessageAt = tracked.length > 0
      ? tracked[tracked.length - 1].timestamp
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

    const update: ConversationUpdate = {
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
    return { update, written, held: [...messages] };
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

    // A message in an archived discussion brings it back (see isArchived):
    // the count of archived ones changed with it.
    if (existing && inArchive(existing) && !inArchive(listEntry)) void refreshArchivedCount();
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

  /**
   * Unload the parts of the window the reader has moved away from, keeping a
   * band of WINDOW_SIZE either side of `anchorMessageId`.
   *
   * Without this the window only grows: paging to the start of a long
   * conversation would end up holding all of it, which is what the window
   * exists to prevent. Centred on the message being read rather than on an
   * end of the list — trimming to "the oldest N" unloaded the very rows being
   * read. Left alone until the window passes WINDOW_MAX.
   */
  async function slideWindowAround(
    conversationId: string,
    anchorMessageId: string,
  ): Promise<{ droppedHead: number; droppedTail: number }> {
    const nothing = { droppedHead: 0, droppedTail: 0 };
    if (currentConversationId.value !== conversationId) return nothing;
    if (chatStore.messages.length <= CONSTANTS.CONVERSATION.WINDOW_MAX) return nothing;

    const { WINDOW_SIZE } = CONSTANTS.CONVERSATION;
    // A turn still writing into the end that is about to go is held apart
    // first; the band the reader is in stays on screen either way.
    const at = chatStore.messages.findIndex((m) => m.id === anchorMessageId);
    if (at === -1) return nothing;
    const keepThroughId = chatStore.messages[at + WINDOW_SIZE]?.id;
    if (keepThroughId && keepThroughId !== chatStore.messages.at(-1)?.id) {
      await releaseWindowFromLiveTurn(conversationId, keepThroughId);
      if (currentConversationId.value !== conversationId) return nothing;
    }

    const slid = chatStore.trimWindowAround(conversationId, anchorMessageId, WINDOW_SIZE, WINDOW_SIZE);
    if (slid.droppedHead || slid.droppedTail) {
      logger.debug('Slid the message window', { conversationId, ...slid });
      pruneWritten(conversationId);
    }
    return slid;
  }

  /**
   * Make the window free to let go of its end, holding a turn that is still
   * writing into it apart first. True when the window no longer holds such a
   * turn.
   *
   * Saved before anything moves, and only on a write that landed: whatever
   * stays in the window may be unloaded next, and only what is on disk can
   * be. A failed write leaves everything where it is.
   */
  async function releaseWindowFromLiveTurn(
    conversationId: string,
    keepThroughId: string | null = null,
  ): Promise<boolean> {
    if (!chatStore.windowHoldsLiveTurn(conversationId)) return true;

    const saved = await saveCurrentConversation();
    if (!saved) {
      logger.warn('Keeping a running turn on screen: the write before moving it did not land', {
        conversationId,
      });
      return false;
    }
    if (currentConversationId.value !== conversationId) return false;
    return chatStore.detachLiveTurn(conversationId, keepThroughId);
  }

  const SAVE_STALL_MS = CONSTANTS.CONVERSATION.SAVE_STALL_MS;
  const SAVE_STALLED_MESSAGE =
    'Saving has stopped working: recent messages may not be stored. '
    + 'Copy anything important, then restart the app.';
  /** The pass writing the queue out, while one runs. */
  let saveWriting: Promise<void> | null = null;
  /**
   * A write waiting to go out, and everyone waiting on it.
   *
   * Each caller is told the outcome of the write that carries ITS snapshot —
   * never of the pass as a whole. Handing back the pass's promise is how a
   * stuck queue once reported every save as done while writing nothing at
   * all: a save is only ever "saved" because its own write landed.
   */
  interface QueuedSave {
    pending: PendingWrite;
    settle: ((saved: boolean) => void)[];
  }
  /** Writes waiting to go out, newest per conversation, in order. */
  const saveQueue = new Map<string, QueuedSave>();
  /**
   * Conversations deleted this session, which nothing may write again.
   *
   * A write is an upsert and creates the file when it is missing, so any save
   * that reached a deleted conversation brought it straight back — the one
   * that started it all was deleting the open conversation, which opens a new
   * one, which saves the one on screen first. Refused at the queue, which
   * every save goes through, rather than at each caller.
   */
  const deletedConversationIds = new Set<string>();
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
    return queueSave(buildConversationUpdate(
      conversationId,
      detached ?? chatStore.messages,
      settingsStore.workingDirectory,
    ));
  }

  /**
   * Queue a write, and resolve with whether THAT write landed.
   *
   * A newer snapshot of a conversation replaces an older one still waiting —
   * the newer is a superset — and whoever waited on the older one is told
   * the outcome of the newer.
   *
   * Watched, too. A save that has neither landed nor failed long after any
   * single write would have timed out means the queue itself has stopped,
   * and that is said loudly — on screen and in main.log — instead of being
   * discovered later as lost conversations.
   */
  function queueSave(pending: PendingWrite): Promise<boolean> {
    const { update } = pending;
    const outcome = new Promise<boolean>((resolve) => {
      const stalled = setTimeout(() => {
        logger.error('A save has not completed; saving may have stopped', {
          conversationId: update.id,
          waitedMs: SAVE_STALL_MS,
          queued: [...saveQueue.keys()],
          passRunning: saveWriting !== null,
        });
        error.value = SAVE_STALLED_MESSAGE;
      }, SAVE_STALL_MS);
      const settle = (saved: boolean) => {
        clearTimeout(stalled);
        resolve(saved);
      };
      const waiting = saveQueue.get(update.id)?.settle ?? [];
      saveQueue.set(update.id, { pending, settle: [...waiting, settle] });
    });
    void drainSaveQueue();
    return outcome;
  }

  /**
   * Write everything queued, one at a time.
   *
   * Serialised so two writes to the same file cannot interleave, and so a
   * caller awaiting a save knows the bytes are down before it continues —
   * `switchConversation` replaces the message list immediately afterwards.
   */
  function drainSaveQueue(): Promise<void> {
    if (saveWriting) return saveWriting;

    saveWriting = (async () => {
      // Yield before anything else. An async function runs synchronously up
      // to its first await, so a pass that writes nothing — every entry for a
      // deleted conversation — reached the `finally` below and cleared
      // `saveWriting` BEFORE this very assignment stored the promise. The
      // finished promise then stayed in `saveWriting` for good, every later
      // save returned it without writing a thing, and nothing was saved again
      // until a restart.
      await Promise.resolve();
      isSaving.value = true;
      error.value = null;
      try {
        while (saveQueue.size > 0) {
          const [id, queued] = saveQueue.entries().next().value as [string, QueuedSave];
          saveQueue.delete(id);
          const conversation = queued.pending.update;
          const report = (saved: boolean) => {
            for (const settle of queued.settle) settle(saved);
          };
          // Gone, so there is nothing left to write for it — which is not a
          // failure, and is not reported as one: the caller's copy is of a
          // conversation that no longer exists, and keeping it would only
          // keep a copy of something deleted.
          if (deletedConversationIds.has(id)) {
            report(true);
            continue;
          }
          try {
            await executeSave(conversation, { useTimeout: true, logPrefix: '' });
            logger.info('Conversation saved successfully', {
              id: conversation.id,
              upsertCount: conversation.upsert.length,
            });
            // What it carried is on disk as sent. A cut it carried removed
            // from the file what was known to be there: forgotten first, so
            // the window refilled below is read after it.
            if (conversation.truncateFromId) forgetWritten(id);
            noteWritten(id, queued.pending.written);
            // The write landed: a removal it carried has reached the file,
            // and everything written is now on disk, so the window may be
            // trimmed back — the only moment at which forgetting part of a
            // conversation is safe.
            if (conversation.truncateFromId) {
              chatStore.clearPendingTruncation(id);
              await refillEmptyWindow(id);
            }
            // A turn collected apart from the window is stored now, so it is
            // simply what follows the window — which is what the "newer
            // messages" count means. Held no longer.
            chatStore.detachedTurnStored(id);
            trimAfterSave(id);
            pruneWritten(id);
            report(true);
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            logger.error('Failed to save conversation', { error: errorMessage, conversationId: id });
            error.value = `Failed to save conversation: ${errorMessage}`;
            // These messages are now in memory only, and the caller that
            // awaited this save is very often about to replace the list
            // holding them. Keep them reachable — all it was built from, not
            // only the changed ones it carried; see retainUnsavedMessages.
            chatStore.retainUnsavedMessages(id, queued.pending.held);
            report(false);
          }
        }
      } finally {
        isSaving.value = false;
        saveWriting = null;
      }
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
    return queueSave(
      buildConversationUpdate(conversationId, messages, settingsStore.workingDirectory),
    );
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
    startedConversationId.value = id;
    chatStore.setCurrentConversation(id);

    // Clear current chat messages
    chatStore.clearMessages();

    persistLastConversationId(id);
    // A new one is active: it is listed there once it has a message.
    if (listView.value !== 'active') void showListView('active');

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
      const page = await readStored(
        id,
        () => window.electron.conversation.getOlder(id, top.id, CONSTANTS.CONVERSATION.WINDOW_SIZE),
        (read) => read.messages,
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
   * Put a window back on screen when a rewind has emptied it.
   *
   * Rewinding the oldest turn ON SCREEN is not rewinding to the start of the
   * conversation: with a window, thousands of messages can still be stored in
   * front of it. The transcript is left empty, and nothing can bring it back
   * by itself — a page of history is fetched against the id at the top of the
   * window, and there is no longer a window to take one from. What the user
   * saw was the empty "start a conversation" state over a file holding
   * thousands of messages, recoverable only by navigating away and back.
   *
   * The conversation now ends just before the turn that was rewound, so the
   * right view is its new end, which is what opening it would show.
   */
  async function refillEmptyWindow(id: string): Promise<void> {
    if (currentConversationId.value !== id) return;
    if (chatStore.messages.length > 0) return;
    if (chatStore.olderMessageCount === 0) return;

    try {
      const latest = await readWindow(id);
      if (!latest || currentConversationId.value !== id) return;
      chatStore.loadMessages(latest.conversation.messages, latest.olderCount, 0);
      logger.info('Refilled the window after a rewind emptied it', {
        id, held: latest.conversation.messages.length, older: latest.olderCount,
      });
    } catch (err) {
      logger.error('Failed to refill the window after a rewind', { id, err });
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
      const held = chatStore.detachedTurnFor(id);
      const page = await readStored(
        id,
        () => window.electron.conversation.getNewer(id, from, CONSTANTS.CONVERSATION.WINDOW_SIZE, held?.[0]?.id ?? null),
        (read) => read.messages,
      );
      if (!page) return 0;
      // Switched away while this was in flight.
      if (currentConversationId.value !== id) return 0;

      // The held turn was stored and let go of while this was read, so the
      // page stops short of messages that are now simply stored and its count
      // is behind. The next approach to the edge asks again.
      if (chatStore.detachedTurnFor(id) !== held) {
        logger.info('Discarded a page of the tail: the held turn changed while it was read', { id });
        return 0;
      }

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
      const latest = await readWindow(id);
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
   * Make sure a message is loaded, so it can be scrolled to. True when it is
   * on screen afterwards.
   *
   * Opening a search hit needs this. The conversation is held as a window of
   * itself, so a hit further back than that window is not loaded, and
   * scrolling to it found no row and did nothing at all.
   *
   * The window is replaced by the stretch around the hit, so it stays a
   * window — including while a turn is still being written into it: that turn
   * is held apart first (see `releaseWindowFromLiveTurn`) and keeps receiving
   * everything it writes off screen. A hit inside that held turn is reached by
   * going back to the end of the conversation instead.
   */
  async function revealMessage(conversationId: string, messageId: string): Promise<boolean> {
    if (currentConversationId.value !== conversationId) return false;
    const onScreen = () => chatStore.messages.some((m) => m.id === messageId);
    if (onScreen()) return true;

    const half = Math.floor(CONSTANTS.CONVERSATION.WINDOW_SIZE / 2);
    try {
      // Re-read, never patched up, if the held turn changes while the stretch
      // is read: its count would be behind. Bounded, because each pass waits
      // on the disk and a turn cannot end more than once.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (chatStore.detachedTurnFor(conversationId)?.some((m) => m.id === messageId)) {
          return (await jumpToLatest()) && onScreen();
        }
        if (!(await releaseWindowFromLiveTurn(conversationId))) {
          // A failed save has already said so, in its own words.
          error.value ??= 'Could not open that part of the conversation while the answer is being written';
          return false;
        }
        if (currentConversationId.value !== conversationId) return false;

        const held = chatStore.detachedTurnFor(conversationId);
        const around = await readStored(
          conversationId,
          () => window.electron.conversation.getAround(conversationId, messageId, half, half, held?.[0]?.id ?? null),
          (read) => read.messages,
        );
        if (currentConversationId.value !== conversationId) return false;
        if (chatStore.detachedTurnFor(conversationId) !== held) continue;
        // A turn started in the window while the stretch was read: it has to
        // be held apart before the window is replaced.
        if (chatStore.windowHoldsLiveTurn(conversationId)) continue;
        if (!around) {
          logger.warn('A search hit is no longer stored', { conversationId, messageId });
          return false;
        }

        chatStore.loadMessages(around.messages, around.olderCount, around.newerCount);
        if (around.newerCount === 0) chatStore.absorbDetachedTurn(conversationId);
        logger.info('Loaded the stretch around a message', {
          conversationId, messageId, held: around.messages.length,
          older: around.olderCount, newer: around.newerCount,
        });
        return onScreen();
      }
      logger.warn('Gave up opening a search hit: the conversation kept changing under it', {
        conversationId, messageId,
      });
      return false;
    } catch (err) {
      logger.error('Failed to load the messages around a search hit', { conversationId, messageId, err });
      error.value = 'Could not load that part of the conversation';
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
    // Nothing may write it from here on — see deletedConversationIds. A write
    // still queued is skipped when its turn comes, and one already under way
    // is waited for, so it lands before the file is removed rather than
    // recreating it after.
    deletedConversationIds.add(id);
    forgetWritten(id);
    if (saveWriting) await saveWriting;

    try {
      await window.electron.conversation.delete(id);

      // A turn still running would go on into a conversation that no longer
      // exists, and hold a run slot while it did. Stopped only once the
      // delete has landed: a delete that failed leaves the turn alone.
      if (chatStore.isConversationLoading(id)) {
        try {
          await window.electron.claude.abort(id);
        } catch (abortErr) {
          logger.warn('Failed to stop the turn of a deleted conversation', { id, error: abortErr });
        }
      }

      // Remove from list
      const index = conversations.value.findIndex((c: Conversation) => c.id === id);
      if (index !== -1) {
        const [removed] = conversations.value.splice(index, 1);
        if (inArchive(removed)) void refreshArchivedCount();
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
      // Still on disk, so still a conversation the user can carry on in.
      deletedConversationIds.delete(id);
    }
  }

  /**
   * Check if a conversation has an active query (loading)
   */
  function isConversationActive(id: string): boolean {
    return chatStore.isConversationLoading(id);
  }

  /** The title the messages give a discussion; see conversation-title.ts. */
  function generateTitle(messages: ChatMessage[]): string {
    return titleFromMessages(messages) ?? 'New Conversation';
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
          // Asked rather than looked up in the list: it may be on a page not
          // loaded, or in the archive.
          const exists = (await window.electron.conversation.summary(config.lastConversationId)) !== null;
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
    for (const [id, unwritten] of chatStore.unwrittenByConversation()) {
      if (id === currentConversationId.value) continue;
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
    openingConversationId,
    isSaving,
    error,

    // Getters
    currentConversation,
    hasConversations,
    listedConversations,
    newDiscussionRow,
    listView,
    listHasMore,
    loadingMoreConversations,
    archivedCount,
    listRevealCount,
    currentModeMismatch,
    currentArchived,
    isConversationArchived,

    // Actions
    loadConversationList,
    loadMoreConversations,
    showListView,
    setConversationArchived,
    loadConversation,
    readWindow,
    writtenRecordCount,
    switchConversation,
    saveCurrentConversation,
    loadEarlierMessages,
    loadNewerMessages,
    jumpToLatest,
    revealMessage,
    slideWindowAround,
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
