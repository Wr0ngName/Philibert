/**
 * Chat store - manages chat messages and Claude interactions
 * Refactored for multi-conversation support with per-conversation state
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

import { modifiedPathsForTool } from '@shared/file-modifications';
import { primaryModelUsage } from '@shared/model-usage';
import type { ChatMessage, PendingAction, BackgroundTask, BackgroundTaskStatus, LiveBackgroundTask, TaskNotification, SessionPermissionEntry, SessionUsage, ToolCaptureData, TaskListItem, ToolUseInfo, ToolResultData, MessageImage } from '@shared/types';

import { generateId, ID_PREFIXES } from '../utils/id';
import { logger } from '../utils/logger';
import type { QueuedPrompt } from '../utils/prompt-queue';

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
  /**
   * Where the running turn starts in the window: it is everything AFTER this
   * message — chunks, tool calls, their results — so it can be told apart
   * from the history before it when it has to be held off screen (see
   * `detachLiveTurn`). `{ id: null }` means it starts at the window's first
   * row; null means it is not known, and nothing is moved on a guess.
   *
   * The message before the turn rather than the turn's first message,
   * because that one does not survive: a turn that opens with a tool call
   * removes its empty first message (see `splitStreamingForTool`), and a
   * marker naming it named nothing. What came before the turn is history,
   * and a turn does not remove history.
   *
   * Left in place after the turn ends: a later turn records its own, and a
   * stale one only names a message further back, which holds more than the
   * turn rather than less.
   */
  turnAfter: { id: string | null } | null;
  /** Pending actions waiting for user approval */
  pendingActions: PendingAction[];
  /**
   * Prompts written while this conversation's turn was running, oldest first.
   *
   * Not part of the transcript and never persisted: these have not been sent,
   * so writing them into the saved conversation would show the user a message
   * they never actually asked, and reloading would lose the queue's meaning
   * (the turn it was waiting on is long over).
   */
  queuedPrompts: QueuedPrompt[];
  /**
   * The queue is waiting for the user, not for a turn.
   *
   * Set when the user stops a turn and when one ends in an error: both mean
   * the next prompt should not go out by itself, the first because stopping is
   * a request for the app to stop working and the second because the prompt
   * was written expecting the turn before it to have succeeded.
   *
   * It has to be remembered rather than inferred from the event, because the
   * queue is re-examined whenever the conditions change — returning to the
   * conversation, room appearing under the run cap — and by then the event is
   * long gone. Cleared when a new turn starts or the user releases the queue.
   */
  queueHeld: boolean;
  /** Background tasks for this conversation */
  backgroundTasks: Map<string, BackgroundTask>;
  /** Model's todo list — reconstructed from TaskCreate/TaskUpdate/TaskList tool
   *  calls. Keyed by SDK task ID once known; keyed by tool_use block ID for the
   *  brief window between TaskCreate call and its result carrying the real ID. */
  taskListItems: Map<string, TaskListItem>;
  /** Session usage (token counts, cost) */
  sessionUsage: SessionUsage | null;
  /**
   * The main-loop model the CLI reports for this conversation. This is the
   * model of record for the discussion — Claude Code itself displays
   * getMainLoopModel(), never a model inferred from token accounting, because
   * a turn's usage legitimately includes the small-fast model doing titles and
   * summaries.
   */
  activeModel: string | null;
  /** Error message if any */
  error: string | null;
  /** Active session permissions for this conversation */
  sessionPermissions: SessionPermissionEntry[];
  /** File paths modified in the last query (cleared on new query) */
  modifiedFilesInLastQuery: Set<string>;
  /**
   * Messages for this conversation while the user is looking at another one.
   *
   * `messages` only ever holds the conversation on screen, so a conversation
   * running in the background had nowhere to put anything: every tool-use
   * function returned early and its history came back with no tool uses in it
   * at all. This is where they go instead until the view comes back.
   */
  /**
   * How many of this conversation's stored messages are older than the ones
   * held in memory.
   *
   * A conversation is loaded as a window of its most recent messages, not in
   * full: nothing capped the list before, so a long one grew in memory for as
   * long as the app ran (measured at ~1.8 KB a message — a 12,000-message
   * conversation is ~21 MB, and every save allocated twice that again). This
   * is what the renderer shows as "earlier messages", and what it asks for a
   * page of.
   *
   * It is also why a write must never carry the whole list: the window is not
   * the conversation. See ConversationUpdate.
   */
  olderCount: number;
  /**
   * How many of this conversation's stored messages come AFTER the ones held
   * in memory.
   *
   * The window slides both ways: reading back through a long conversation
   * loads older pages and unloads the newest, so the loaded set stays bounded
   * however far back the reader goes. Non-zero means the list on screen ends
   * before the conversation does — so "at the bottom" is not "at the end",
   * and reaching the newest message means loading it rather than scrolling to
   * it.
   *
   * Non-zero means the window does not reach the end of the conversation, and
   * a turn arriving then is written to {@link detachedTurn} rather than to a
   * list it does not belong to.
   */
  newerCount: number;
  /**
   * Messages produced while the window did not reach the end of the
   * conversation, and not yet stored.
   *
   * Reading far enough back unloads the newest messages, and the conversation
   * can still receive a turn — a background task finishing, a channel
   * message, a prompt sent from the composer without scrolling down. Those
   * messages do not follow the ones on screen: hundreds sit in between,
   * stored and not loaded. Appending them to the window anyway leaves a hole
   * in the middle of it, which is a thing that has to be tracked everywhere
   * the window is touched — and every place it was not tracked was a defect:
   * a page fetched afterwards appended to the wrong end, a second hole
   * opening, the first hole never closing, the whole remainder of the
   * conversation stranded.
   *
   * So the ONE invariant is kept instead: **what is on screen is always one
   * unbroken range of the conversation.** A turn that does not belong to that
   * range collects here.
   *
   * It is what gets written for such a conversation, and that is sound
   * because a write is an upsert — it adds and replaces by id and never
   * shortens the file (see ConversationUpdate), so a payload that is only
   * what changed is exactly what the contract was built for. Once the write
   * lands, these messages ARE stored after the window, which is what
   * `newerCount` counts, so it grows by their number and this empties.
   *
   * Empty whenever the window reaches the end, which is the normal case.
   */
  detachedTurn: ChatMessage[];
  /**
   * A removal of history that has happened on screen and has yet to reach
   * disk.
   *
   * Writes are upserts — they add and replace, never shorten (see
   * ConversationUpdate) — so a rewind has to say so explicitly or the turns
   * it dropped would stay in the file and come back on the next visit.
   * `fromId` is the oldest message being discarded, named that way round
   * because the on-screen list is a window and the message BEFORE the oldest
   * one in it is not held. Cleared only once a write carrying it has
   * succeeded.
   */
  pendingTruncation: { fromId: string } | null;
  /**
   * Whether the view of this conversation is sitting at the newest message.
   *
   * Kept here because the window is trimmed from the store and the viewport
   * lives in the component. Trimming removes rows ABOVE what is on screen: at
   * the bottom that is invisible, because the browser clamps the scroll offset
   * and the newest message stays where it is — but to a user scrolled back
   * reading history it would yank the page forward by the height of
   * everything removed. So a conversation being read is left alone and trimmed
   * the next time its view returns to the tail.
   *
   * True by default: a conversation that has just been opened is at its end.
   */
  tailPinned: boolean;
  bufferedMessages: ChatMessage[];
  /**
   * Whether {@link bufferedMessages} is live. Distinguishes "running in the
   * background, buffer is the sink" from "not running, nothing to update" —
   * an empty buffer alone cannot tell those apart.
   */
  bufferingMessages: boolean;
}

/**
 * Create a fresh conversation state object
 */
function createConversationState(): ConversationState {
  return {
    isLoading: false,
    currentStreamingContent: '',
    streamingMessageId: null,
    turnAfter: null,
    pendingActions: [],
    queuedPrompts: [],
    queueHeld: false,
    backgroundTasks: new Map(),
    taskListItems: new Map(),
    sessionUsage: null,
    activeModel: null,
    error: null,
    sessionPermissions: [],
    modifiedFilesInLastQuery: new Set(),
    olderCount: 0,
    newerCount: 0,
    detachedTurn: [],
    pendingTruncation: null,
    tailPinned: true,
    bufferedMessages: [],
    bufferingMessages: false,
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

  // The main-loop model for the current conversation — the model of record
  // for the discussion indicator.
  const activeModel = computed(() => {
    const state = getCurrentState();
    return state?.activeModel ?? null;
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

  // Current conversation's queued prompts, for the strip above the input.
  const queuedPrompts = computed((): QueuedPrompt[] => {
    const state = getCurrentState();
    return state?.queuedPrompts ?? [];
  });

  /** Whether the current conversation's queue is waiting on the user. */
  const queueHeld = computed(() => getCurrentState()?.queueHeld ?? false);

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

  // Current conversation's model todo list (from SDK Task* tools)
  const taskListItems = computed((): TaskListItem[] => {
    const state = getCurrentState();
    if (!state) return [];
    return Array.from(state.taskListItems.values()).filter(t => t.status !== 'deleted');
  });

  const hasTaskListItems = computed(() => taskListItems.value.length > 0);

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
    // Size against the model that actually served the turn, not whichever
    // entry landed last in the usage map. Picking the last one could size an
    // Opus conversation against Haiku's 200K window and overstate context
    // usage roughly fivefold — see @shared/model-usage.
    return primaryModelUsage(sessionUsage.value?.modelUsage)?.contextWindow ?? 0;
  });

  const contextUsagePercent = computed(() => {
    if (contextWindowSize.value === 0) return 0;
    return Math.min(100, (totalTokensUsed.value / contextWindowSize.value) * 100);
  });

  // Resource limit caps concurrently *running* turns, not open persistent
  // sessions. Idle sessions don't count — they only get torn down when the
  // SDK subprocess exits, so counting them here would leak the counter.
  const isAtResourceLimit = computed(() =>
    processingQueryCount.value >= maxConcurrentQueries.value
  );

  const canStartNewQuery = computed(() =>
    processingQueryCount.value < maxConcurrentQueries.value
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
    const leaving = currentConversationId.value;
    if (leaving && leaving !== conversationId) detachMessageBuffer(leaving);
    currentConversationId.value = conversationId;
  }

  /**
   * Give a conversation leaving the screen its own copy of the history it was
   * sharing with the on-screen list.
   *
   * While a conversation is in view its buffer IS the on-screen list, so that
   * the two cannot diverge (see `bufferTarget`). The moment it leaves, the
   * sharing has to stop or the background turn would write into whatever the
   * user is now looking at.
   *
   * Done here rather than relying on `loadMessages` replacing the array,
   * because that would make the invariant depend on the caller making two
   * calls in the right order — and `setCurrentConversation` is a public action
   * that can be called on its own.
   *
   * A shallow copy: the message objects stay shared, which is what keeps a
   * streaming message's accumulated content correct in both places, while new
   * messages go only to the buffer.
   */
  function detachMessageBuffer(conversationId: string): void {
    const state = conversationStates.value.get(conversationId);
    if (!state?.bufferingMessages) return;
    if (state.bufferedMessages === messages.value) {
      state.bufferedMessages = [...messages.value];
    }
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
    // Through the sink, not straight at the on-screen list: that list is a
    // window, and appending to it is only meaningful when it ends where the
    // conversation does. See `messageSink`.
    const current = currentConversationId.value;
    const sink = current ? messageSink(current) : messages.value;
    addMessageTo(sink ?? messages.value, message);
  }

  /**
   * Append to a specific message list.
   *
   * Deliberately unbounded. This used to splice the oldest messages off once
   * the list passed a 1000-message cap, which destroyed the user's
   * transcript: this array *is* what gets persisted —
   * `buildConversationPayload(id, chatStore.messages, …)` in the conversations
   * store serialises it verbatim — so the next autosave wrote the truncated
   * list back over the file. Scrollback past the cap was gone for good, with
   * nothing said about it.
   *
   * The cap existed to keep the DOM manageable, which is a rendering concern
   * and is now solved by rendering only the visible rows (see
   * useVirtualList / MessageList). Trimming history is not a legitimate way to
   * make a list render faster.
   */
  function addMessageTo(sink: ChatMessage[], message: ChatMessage): void {
    sink.push(message);
  }

  /**
   * The message list a conversation's updates should be written to: the
   * on-screen list when it is the active one AND that list reaches the end of
   * the conversation, otherwise {@link ConversationState.detachedTurn} or its
   * background buffer.
   *
   * The on-screen list is a window, and a window is only a valid place to
   * append to when it ends where the conversation ends. Scrolled back far
   * enough that the newest messages have been unloaded, it is not: what
   * arrives belongs after messages that are not loaded, and putting it on the
   * end of the window says it follows the one before it. See `detachedTurn`.
   *
   * Null means the conversation is neither on screen nor running in the
   * background, so there is genuinely nothing to update — as opposed to the
   * old behaviour, where every caller treated "not the active conversation"
   * as a reason to discard the update.
   */
  function messageSink(conversationId: string): ChatMessage[] | null {
    // A turn that does not belong to the window collects apart from it,
    // whether or not the conversation is the one on screen.
    const state = conversationStates.value.get(conversationId);
    if (state && !windowReachesEnd(conversationId)) return state.detachedTurn;
    return windowList(conversationId);
  }

  /**
   * The list that IS the window — what the reader is looking at, or the
   * background copy of it for a conversation that has left the screen.
   *
   * Distinct from {@link messageSink}, and the distinction is the whole point:
   * this is the range of the conversation that is loaded, and it is what the
   * paging and trimming act on. The sink is where a TURN's messages go, which
   * is somewhere else entirely when the window does not reach the end.
   * Conflating the two is what made every window operation quietly reshape a
   * turn instead: trimming it, paging into it, counting it twice.
   */
  function windowList(conversationId: string): ChatMessage[] | null {
    if (conversationId === currentConversationId.value) return messages.value;
    const state = conversationStates.value.get(conversationId);
    if (!state || !state.bufferingMessages) return null;
    return state.bufferedMessages;
  }

  /**
   * Does the window run to the end of the conversation?
   *
   * Not if anything comes after it: stored messages it does not hold, or a
   * turn held apart from it. The second is not always accompanied by the
   * first — a running turn moved off screen (see `detachLiveTurn`) can be all
   * there is after the window — and counting only stored messages put that
   * turn's chunks back into a window that no longer holds it.
   */
  function windowReachesEnd(conversationId: string): boolean {
    const state = conversationStates.value.get(conversationId);
    if (!state) return true;
    return state.newerCount === 0 && state.detachedTurn.length === 0;
  }

  /**
   * Start buffering messages for a conversation, seeded with what is on
   * screen now. Called when a turn starts, so the buffer is already a
   * complete history if the user switches away mid-turn.
   */
  function beginMessageBuffer(conversationId: string): void {
    const state = getConversationState(conversationId);
    // A conversation whose window falls short of the end needs no buffer: its
    // turn is collecting in `detachedTurn`, which already survives the user
    // switching away, and which is what gets written. Buffering as well would
    // put a second claimant on the same messages — and a buffer is treated as
    // a complete history when the user comes back, which a lone turn is not.
    if (!windowReachesEnd(conversationId)) return;
    state.bufferedMessages = bufferTarget(conversationId);
    state.bufferingMessages = true;
  }

  /**
   * The array a conversation's buffer should be.
   *
   * For the conversation on screen this is the on-screen list ITSELF, not a
   * copy. The buffer used to be seeded as a copy at turn start, and from then
   * on `messageSink` wrote to the on-screen list for as long as the
   * conversation stayed in view — so everything the first half of a turn
   * produced went into one array and the buffer kept the stale snapshot.
   *
   * That was not a cosmetic difference. The buffer is authoritative twice:
   * `loadConversation` prefers it to the saved file when the user switches
   * back ("they're more up-to-date than the saved file"), and the turn's
   * completion saves it over that file. So a buffer missing the first half of
   * a turn made those messages vanish on switching back, and then deleted
   * them from disk.
   *
   * Sharing the array removes the divergence rather than trying to keep two
   * copies in step. It detaches by itself at exactly the right moment:
   * `loadMessages` assigns a NEW array to `messages` when another conversation
   * comes on screen, leaving the buffer holding the complete history of the
   * one that left — which is what the background path then appends to.
   */
  function bufferTarget(conversationId: string): ChatMessage[] {
    if (conversationId === currentConversationId.value) return messages.value;
    // A conversation that is not on screen has no list to share; it starts
    // from whatever it already had. Not expected — a turn starts in the
    // conversation the user is looking at — but it must not silently adopt
    // another conversation's messages.
    return conversationStates.value.get(conversationId)?.bufferedMessages ?? [];
  }

  /**
   * Keep a conversation's history reachable after its save did not land.
   *
   * The on-screen array is the only copy of anything written since the last
   * successful write, and `switchConversation` replaces it the moment the
   * save it awaited comes back — without looking at whether that save
   * succeeded. So a write that failed used to destroy exactly the messages it
   * failed to persist: the next visit read the file, which still held the
   * older history, and the newest turn was gone. That is the reported loss,
   * and the refused writes were only one way to get there — a full disk, a
   * locked file, a timeout or antivirus holding the handle on Windows all end
   * the same way.
   *
   * Retaining through the buffer rather than a second store of unsaved
   * messages means the rest of the machinery already handles it:
   * `loadConversation` prefers the buffer to the saved file, so switching
   * back shows the messages; `detachMessageBuffer` gives it its own copy when
   * the conversation leaves the screen; and `cleanup` flushes every buffering
   * conversation on close, so the write gets another chance.
   *
   * A turn already collecting in the background owns the buffer and its list
   * is newer than any snapshot — it is left alone. Otherwise the live
   * on-screen array wins over the snapshot that failed, since it can only be
   * more complete.
   */
  function retainUnsavedMessages(conversationId: string, snapshot: ChatMessage[]): void {
    const state = getConversationState(conversationId);
    if (state.bufferingMessages) return;

    // A conversation whose window falls short of the end keeps its unwritten
    // turn in `detachedTurn` already, and that outlives any switch — so there
    // is nothing to retain here, and retaining the window instead would claim
    // the turn had been written.
    if (!windowReachesEnd(conversationId)) return;

    const retained = conversationId === currentConversationId.value
      ? messages.value
      : snapshot;
    if (retained.length === 0) return;

    state.bufferedMessages = retained;
    state.bufferingMessages = true;
  }

  /** Buffered messages for a conversation, or null when it is not buffering. */
  function getBufferedMessages(conversationId: string): ChatMessage[] | null {
    const state = conversationStates.value.get(conversationId);
    if (!state || !state.bufferingMessages) return null;
    return state.bufferedMessages;
  }

  /**
   * Conversations collecting a turn in the background.
   *
   * For flushing them to disk when the app is closing: their buffers hold
   * everything since the last save, and nothing else would write it.
   */

  /**
   * The messages a conversation is holding that are not on disk, or null.
   *
   * The single answer to "what is there to write for this conversation",
   * asked by the turn that just finished out of sight, by the app closing,
   * and by the on-screen save. There are two places such messages can be —
   * a detached turn, or a background buffer — and a caller that only knew
   * about one of them wrote nothing at all for a conversation holding the
   * other. That is not a lost update, it is a lost turn: measured, a
   * background turn in a conversation whose window fell short of the end was
   * dropped entirely at turn end, with nothing logged.
   */
  function unwrittenMessagesFor(conversationId: string): ChatMessage[] | null {
    const state = conversationStates.value.get(conversationId);
    if (!state) return null;
    if (state.detachedTurn.length > 0) return state.detachedTurn;
    if (state.bufferingMessages && state.bufferedMessages.length > 0) {
      return state.bufferedMessages;
    }
    return null;
  }

  /**
   * Every conversation holding messages that are not on disk, with those
   * messages.
   *
   * The work itself rather than a list of ids to ask about: a caller handed
   * ids has to ask each one again, and then there are two filters for one
   * decision. Mutation testing found exactly that — removing either filter
   * changed nothing, because the other one covered for it, which is the
   * definition of one of them being dead.
   */
  function unwrittenByConversation(): [string, ChatMessage[]][] {
    const work: [string, ChatMessage[]][] = [];
    for (const id of conversationStates.value.keys()) {
      const unwritten = unwrittenMessagesFor(id);
      if (unwritten) work.push([id, unwritten]);
    }
    return work;
  }

  /**
   * Release the buffer — but only for the conversation on screen, which has
   * the live list to fall back on.
   *
   * Releasing it for a conversation that is NOT on screen takes away the only
   * place its content can go: `messageSink` then returns null, and
   * `appendChunk` silently updates nothing. Text really does stop appearing
   * mid-message while the turn runs on, which is not a spinner problem and was
   * never one — the turn-lifecycle work was all about the UI failing to notice
   * a turn had ENDED.
   *
   * Output arriving after a turn ends is normal, not exceptional: a background
   * task's poll can escalate into real model work (the case `appendChunk`'s own
   * comment describes), and this is called the moment a turn ends. So a
   * conversation off screen keeps its buffer until it is next viewed, at which
   * point `loadMessages` re-points it at the live list.
   *
   * Keeping it is also safe against the conversely dangerous outcome: the
   * buffer was seeded from the full on-screen history while the conversation
   * was in view, so it stays a complete transcript and cannot overwrite the
   * saved file with a fragment.
   */
  function endMessageBuffer(conversationId: string): void {
    const state = conversationStates.value.get(conversationId);
    if (!state) return;
    if (conversationId !== currentConversationId.value) return;
    state.bufferedMessages = [];
    state.bufferingMessages = false;
  }

  function addUserMessage(content: string, images?: MessageImage[]): ChatMessage {
    const message: ChatMessage = {
      id: generateId(ID_PREFIXES.MESSAGE),
      role: 'user',
      content,
      timestamp: Date.now(),
      // References to bytes already in the image store, so the transcript can
      // show what was sent without the message carrying it.
      ...(images && images.length > 0 ? { images } : {}),
    };
    addMessage(message);
    return message;
  }

  /**
   * Add a complete assistant message, with no streaming involved.
   *
   * For answers the app produces itself — a slash command handled in the GUI,
   * for instance. Streamed replies go through startAssistantMessage and
   * appendChunk instead; using those here would leave the turn spinner running,
   * since nothing would ever arrive to finish the stream.
   */
  function addAssistantMessage(content: string): ChatMessage {
    const message: ChatMessage = {
      id: generateId(ID_PREFIXES.MESSAGE),
      role: 'assistant',
      content,
      timestamp: Date.now(),
    };
    addMessage(message);
    return message;
  }

  /**
   * Record Claude Code's transcript id against the user turn it belongs to.
   *
   * Assigned to the newest user message that does not have one yet. The CLI
   * echoes a turn back right after it is pushed and before any assistant
   * content, so the newest unlabelled user message is the one it refers to.
   *
   * Goes through messageSink so a conversation running in the background gets
   * its ids too — otherwise its turns would silently become un-rewindable just
   * for having been started from another tab.
   */
  function recordUserTurnUuid(conversationId: string, uuid: string): void {
    const sink = messageSink(conversationId);
    if (!sink) return;

    for (let i = sink.length - 1; i >= 0; i -= 1) {
      const message = sink[i];
      if (message.role !== 'user') continue;
      if (message.turnUuid) return; // Newest user turn is already labelled.
      message.turnUuid = uuid;
      return;
    }
  }

  /**
   * Drop everything that came after a user turn, that turn included.
   *
   * Used after a conversation-scope rewind, so the transcript on screen matches
   * the one the next session will resume with. Without this the view would keep
   * showing turns Claude Code has been told to forget, and the user would be
   * reading a history the model no longer has.
   *
   * The turn itself goes too: resumeSessionAt resumes *at* that prompt, so it
   * is about to be replayed rather than kept.
   */
  function truncateAfterUserTurn(conversationId: string, turnUuid: string): void {
    // The transcript, not the sink: a rewind acts on what the user is reading,
    // and while a turn is collecting apart from the window the sink is that
    // turn. Searching it finds nothing and silently rewinds nothing at all.
    const sink = windowList(conversationId);
    if (!sink) return;

    const index = sink.findIndex(
      (message) => message.role === 'user' && message.turnUuid === turnUuid,
    );
    if (index === -1) return;

    // Record what the file has to lose, named as the oldest message being
    // discarded. A write cannot shorten a stored conversation on its own, so
    // without this the dropped turns would survive on disk and reappear on
    // the next visit.
    //
    // Naming the last SURVIVOR instead cannot work for a window: rewinding to
    // the oldest turn on screen has no predecessor to name, and "after
    // nothing" meant "drop the whole conversation" — including the thousands
    // of stored messages the window was not holding.
    const state = getConversationState(conversationId);
    state.pendingTruncation = { fromId: sink[index].id };

    sink.splice(index);

    // A rewind means "forget everything after this point", and everything
    // after the window is after that point too: the stored messages the
    // window stops short of, and a turn collected apart from it. Both go.
    //
    // The write carries the truncation, so the stored ones are already gone;
    // the detached turn has to be dropped here or the SAME write puts it
    // back, appending the messages the rewind was told to forget onto the end
    // of the file — and until then the badge goes on offering a jump to them.
    state.newerCount = 0;
    state.detachedTurn = [];
  }

  /**
   * Record whether a conversation's view is at the newest message. Called by
   * the message list as the user scrolls; see `tailPinned`.
   */
  function setTailPinned(conversationId: string, pinned: boolean): void {
    getConversationState(conversationId).tailPinned = pinned;
  }

  /** Whether trimming this conversation's window would move what is on screen. */
  function isTailPinned(conversationId: string): boolean {
    return conversationStates.value.get(conversationId)?.tailPinned ?? true;
  }

  /** A removal of history not yet written, if there is one. */
  function pendingTruncationFor(
    conversationId: string,
  ): { fromId: string } | null {
    return conversationStates.value.get(conversationId)?.pendingTruncation ?? null;
  }

  /**
   * Forget a removal once a write carrying it has landed.
   *
   * Kept until then on purpose: a failed write must not quietly turn a rewind
   * into something the file never hears about.
   */
  function clearPendingTruncation(conversationId: string): void {
    const state = conversationStates.value.get(conversationId);
    if (state) state.pendingTruncation = null;
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
    // Finalise anything still marked streaming before taking over the slot.
    // Overwriting state.streamingMessageId without this orphaned the previous
    // message: nothing could ever clear its isStreaming flag again, and the
    // turn spinner keys off any streaming message in the group.
    const previous = conversationStates.value.get(conversationId);
    const existingSink = messageSink(conversationId);
    if (previous?.streamingMessageId && existingSink) {
      for (let i = existingSink.length - 1; i >= 0; i--) {
        if (existingSink[i].isStreaming) existingSink[i].isStreaming = false;
      }
    }

    const message: ChatMessage = {
      id: generateId(ID_PREFIXES.MESSAGE),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };

    // Goes on screen when this conversation is the one being viewed, and into
    // its background buffer otherwise, so a conversation running out of sight
    // still builds a complete history.
    const sink = messageSink(conversationId);
    if (sink) {
      addMessageTo(sink, message);
    }

    // Track streaming state for this conversation
    const state = getConversationState(conversationId);
    state.currentStreamingContent = '';
    // Only name a streaming target that actually exists. Recording the id of a
    // message that was never added left the store believing it was streaming
    // into it, and every later chunk then updated nothing at all — the text
    // stopped appearing with no error anywhere. `endMessageBuffer` no longer
    // takes the sink away from a conversation off screen, so this should not
    // happen; it is said out loud rather than trusted, because the failure it
    // guards is invisible.
    if (sink) {
      state.streamingMessageId = message.id;
    } else {
      state.streamingMessageId = null;
      logger.error('Streaming started for a conversation with nowhere to put it', {
        conversationId,
        isCurrent: conversationId === currentConversationId.value,
      });
    }

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

    // Update the message itself too — on screen, or in the background buffer
    // when the user is looking elsewhere, so each streamed segment is kept
    // rather than only the last one surviving to the save.
    const sink = messageSink(conversationId);
    if (sink && state.streamingMessageId) {
      // Search from end for the streaming message — it may not be the very last
      // message because background task or tool use messages can be appended after it.
      for (let i = sink.length - 1; i >= 0; i--) {
        const msg = sink[i];
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

    if (conversationId === currentConversationId.value) {
      // Sync the tracked message's content, then clear isStreaming on EVERY
      // message in the conversation.
      //
      // The turn spinner is driven by `messages.some(m => m.isStreaming)`, but
      // this only ever cleared the one message in state.streamingMessageId. Any
      // other message left streaming — a turn that ended without a done event,
      // a conversation switched away from mid-turn, a startAssistantMessage
      // that replaced the tracked id — pinned the spinner permanently, no
      // matter that the turn had finished and isLoading had gone false.
      // The sink rather than the on-screen list: a turn written while the
      // window did not reach the end of the conversation lives in
      // `detachedTurn`, and leaving its messages marked as streaming pins the
      // spinner forever — the very failure this loop was widened to fix.
      const sink = messageSink(conversationId) ?? messages.value;
      for (let i = sink.length - 1; i >= 0; i--) {
        const msg = sink[i];
        if (!msg.isStreaming) continue;
        if (msg.id === state.streamingMessageId) {
          msg.content = state.currentStreamingContent;
        }
        msg.isStreaming = false;
      }
    }

    state.streamingMessageId = null;
    state.currentStreamingContent = '';
  }

  function clearMessages(): void {
    messages.value = [];
    repointBufferToScreen();
    // Don't clear conversation state here - that's separate
  }

  /**
   * Point a live buffer at the list now on screen.
   *
   * Everything that replaces `messages` wholesale has to call this. While a
   * conversation is in view its buffer IS the on-screen array (see
   * `bufferTarget`), so assigning a new array leaves the buffer holding the
   * previous one — and because `loadConversation` prefers the buffer to the
   * saved file, a stale buffer resurrects whatever was replaced. `/clear`
   * demonstrated it: the cleared messages stayed in the buffer and came back
   * on the next visit.
   */
  function repointBufferToScreen(): void {
    const current = currentConversationId.value;
    if (!current) return;
    const state = conversationStates.value.get(current);
    if (state?.bufferingMessages) state.bufferedMessages = messages.value;
  }

  /**
   * Put a conversation's messages on screen.
   *
   * Both counts are the window's accounting and have to travel with the list:
   * how many stored messages fall either side of it. They default to "this is
   * the whole conversation", which is what a newly created one is.
   *
   * Passing a windowed list and letting them default is a silent corruption
   * rather than an approximation, and it shipped once: restoring a background
   * conversation from its buffer dropped `newerCount` to 0, so a window that
   * stopped hundreds of messages short of the end was treated as the end of
   * the conversation — nothing said otherwise and the badge that was the only
   * way to the rest of it was gone.
   */
  function loadMessages(
    loadedMessages: ChatMessage[],
    olderCount = 0,
    newerCount = 0,
  ): void {
    // Nothing is streaming at load time. A message persisted mid-turn keeps
    // isStreaming: true, and restoring it verbatim shows a spinner for a turn
    // that ended long ago — possibly in a previous run of the app.
    messages.value = loadedMessages.map((m) =>
      m.isStreaming ? { ...m, isStreaming: false } : m,
    );

    const current = currentConversationId.value;
    if (current) {
      const state = getConversationState(current);
      state.olderCount = olderCount;
      state.newerCount = newerCount;
    }

    // Re-point a running turn's buffer at the list that is now on screen.
    //
    // This is the other half of sharing the array (see `bufferTarget`). When
    // the user switches back into a conversation whose turn is still running,
    // this replaces `messages` with a fresh array — so without re-pointing,
    // the buffer would be left referring to the array from before the switch
    // and would start diverging again the moment anything was added.
    repointBufferToScreen();
  }

  /**
   * Put a page of earlier messages in front of the window.
   *
   * The messages the user scrolled back to. `olderCount` is what is left
   * behind them, as the main process counted it — taken from the answer
   * rather than decremented here, so a miscount cannot accumulate.
   */
  function prependOlderMessages(
    conversationId: string,
    older: ChatMessage[],
    olderCount: number,
  ): void {
    const state = getConversationState(conversationId);
    state.olderCount = olderCount;
    if (older.length === 0) return;

    const sink = windowList(conversationId);
    if (!sink) return;

    // No dedupe, deliberately. A page is fetched against the id at the edge
    // of the window, so what comes back is strictly outside it; and a
    // duplicate id cannot reach here, because the stored transcript is
    // cleaned of repeats where the file is read (see `withoutRepeatedIds`).
    // A filter here could not have handled the real case anyway — two copies
    // inside ONE page are not yet "already held" when they arrive.
    sink.unshift(...older.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m)));
  }

  /**
   * Put a page of newer messages after the window.
   *
   * The way back down after reading history: the newest messages were
   * unloaded to keep the loaded set bounded, and this is how they return.
   *
   * Always an append, because the window is always one unbroken range and
   * this extends its far end. A turn that arrived while the window fell short
   * of the end is not in it (see
   * {@link ConversationState.detachedTurn}) and goes back on only once the
   * window has caught up with the conversation.
   */
  function appendNewerMessages(
    conversationId: string,
    newer: ChatMessage[],
    newerCount: number,
  ): void {
    const state = getConversationState(conversationId);
    state.newerCount = newerCount;

    const sink = windowList(conversationId);
    if (!sink) return;

    // No dedupe; see prependOlderMessages.
    if (newer.length > 0) {
      sink.push(...newer.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m)));
    }
    // Even after an empty page: when all that is left after the window is a
    // turn held apart from it, reaching the end of what is stored IS reaching
    // that turn.
    if (newerCount === 0) absorbDetachedTurn(conversationId);
  }

  /**
   * Put a detached turn back on the end of the window, now that the window
   * reaches the end of the conversation.
   *
   * The two are disjoint by construction — the turn collected there precisely
   * because it did not belong to the window — so this is an append, and the
   * dedupe is for the one case where it is not: the turn had been saved, so
   * the page that caught the window up contains it already.
   */
  function absorbDetachedTurn(conversationId: string): void {
    const state = conversationStates.value.get(conversationId);
    if (!state) return;
    // The on-screen list belongs to the conversation on screen. Absorbing
    // another one's turn into it would append that turn to the wrong
    // transcript, and the next save would write it there.
    if (conversationId !== currentConversationId.value) return;

    // A message the window already holds is a stored copy of a held one —
    // read off disk by the page or the jump that caught the window up — and
    // the held one is never behind it: it is what the turn has been writing
    // into since. So the held object takes the copy's place rather than the
    // copy being kept. Keeping the copy showed a running turn as it was when
    // last saved, and its next chunk was appended to that stale text.
    const position = new Map(messages.value.map((m, i) => [m.id, i]));
    const first = state.detachedTurn[0];
    for (const message of state.detachedTurn) {
      const at = position.get(message.id);
      if (at === undefined) messages.value.push(message);
      else messages.value[at] = message;
    }
    state.detachedTurn = [];

    // Wherever the turn now sits in the window is where it starts — the
    // window it started from may be long gone.
    if (first && state.isLoading) {
      const at = messages.value.indexOf(first);
      state.turnAfter = { id: at > 0 ? messages.value[at - 1].id : null };
    }

    // Back on screen while still being written: buffer it again, so it keeps
    // a sink if the user leaves the conversation before it ends.
    if (state.isLoading) beginMessageBuffer(conversationId);
  }

  /**
   * Whether a turn is still writing into `list`: one is running, its output
   * is being buffered, or a message in it is still streaming. An arriving
   * chunk looks for its message in the window, so such a list must not be
   * unloaded.
   */
  function turnIsLive(state: ConversationState, list: readonly ChatMessage[]): boolean {
    return turnIsWriting(state, list) || state.bufferingMessages;
  }

  /**
   * Whether a turn is actually writing into `list` now: running, or a message
   * in it still streaming. Narrower than {@link turnIsLive}, which also counts
   * a buffer kept after a failed write — that holds history to be saved, not
   * a turn with chunks and results still to come.
   */
  function turnIsWriting(state: ConversationState, list: readonly ChatMessage[]): boolean {
    return state.isLoading || list.some((m) => m.isStreaming);
  }

  /**
   * Whether the window on screen holds a turn that is still being written.
   *
   * Only a window that reaches the end of the conversation can: one that
   * falls short collects a live turn apart from itself (see
   * {@link ConversationState.detachedTurn}), so replacing it loses nothing.
   */
  function windowHoldsLiveTurn(conversationId: string): boolean {
    const state = conversationStates.value.get(conversationId);
    const list = windowList(conversationId);
    if (!state || !list || !windowReachesEnd(conversationId)) return false;
    return turnIsLive(state, list);
  }

  /**
   * Move the turn being written out of the on-screen window and hold it apart
   * from it, so the window can let go of its end. True when the window no
   * longer holds a live turn.
   *
   * Reading back, or opening a search hit, unloads the newest messages — and
   * while a turn was writing into them that was refused outright, so the
   * window grew past its bound for as long as the turn ran. Unloading them
   * anyway would take away the list the turn's chunks and tool results look
   * their messages up in. Held apart instead, they keep receiving all of it
   * (see `messageSink`), are written from there, and come back on the end of
   * the window once it reaches the end of the conversation again.
   *
   * The caller must have saved the window first, and seen the write land:
   * everything left in the window may be unloaded after this, and only what
   * is on disk can be.
   *
   * `keepThroughId` is the last message the reader still needs on screen. A
   * turn that starts at or before it is what they are reading, and is left
   * where it is. An id rather than an index, because the save the caller made
   * first can trim the head of the window and move every index.
   */
  /**
   * Index in `list` at which the running turn starts (see `turnAfter`), or
   * -1 when that is not known — in which case nothing may be moved or
   * dropped on its account.
   */
  function turnStartIn(state: ConversationState, list: readonly ChatMessage[]): number {
    const after = state.turnAfter;
    if (!after) return -1;
    if (after.id === null) return 0;
    const at = list.findIndex((m) => m.id === after.id);
    return at === -1 ? -1 : at + 1;
  }

  function detachLiveTurn(conversationId: string, keepThroughId: string | null = null): boolean {
    const state = conversationStates.value.get(conversationId);
    if (!state || conversationId !== currentConversationId.value) return false;
    if (!windowHoldsLiveTurn(conversationId)) return true;

    const list = messages.value;
    // Live only because a failed write left a buffer holding the history
    // (see retainUnsavedMessages). The caller's write just landed, so that
    // buffer has done its job and nothing is being written.
    if (!turnIsWriting(state, list)) {
      endMessageBuffer(conversationId);
      return true;
    }

    const start = turnStartIn(state, list);
    if (start === -1) {
      logger.warn('Cannot tell where the running turn starts; keeping it on screen', {
        conversationId, turnAfter: state.turnAfter,
      });
      return false;
    }
    const keepThrough = keepThroughId ? list.findIndex((m) => m.id === keepThroughId) : -1;
    if (start <= keepThrough) return false;

    // In place: the list is shared with the buffer, which is ended right
    // after — a turn held apart needs none (see beginMessageBuffer).
    state.detachedTurn = list.splice(start);
    endMessageBuffer(conversationId);
    logger.info('Held a running turn apart from the window', {
      conversationId, held: state.detachedTurn.length, window: list.length,
    });
    return true;
  }

  /**
   * Keep a band of the window around one message, dropping both ends.
   *
   * This is what sliding means. Trimming to "the oldest N" or "the newest N"
   * is anchored to an end of the list, and after a page has been prepended the
   * reader sits several hundred rows below the new top — so keeping the oldest
   * N unloaded the very rows they were looking at. The band is measured from
   * where they are.
   *
   * The tail end is refused while the window holds a turn that is still being
   * written: an arriving chunk looks for its message in the window, and
   * unloading the tail would leave it nowhere to go. The conversations store
   * holds such a turn apart first (`detachLiveTurn`), after which the tail is
   * stored history like any other. The head end has no such constraint.
   */
  function trimWindowAround(
    conversationId: string,
    anchorMessageId: string,
    keepBefore: number,
    keepAfter: number,
  ): { droppedHead: number; droppedTail: number } {
    const nothing = { droppedHead: 0, droppedTail: 0 };
    const state = conversationStates.value.get(conversationId);
    if (!state) return nothing;

    const sink = windowList(conversationId);
    if (!sink) return nothing;

    const at = sink.findIndex((m) => m.id === anchorMessageId);
    if (at === -1) return nothing;

    const keepUntil = at + keepAfter;
    let droppedTail = Math.max(0, sink.length - 1 - keepUntil);
    // A turn still writing into the window keeps its end; `detachLiveTurn`
    // moves it out first when the end has to go.
    if (droppedTail > 0 && windowHoldsLiveTurn(conversationId)) droppedTail = 0;

    const droppedHead = Math.max(0, at - keepBefore);

    // Tail first: dropping the head shifts every index below it.
    if (droppedTail > 0) {
      sink.splice(keepUntil + 1, droppedTail);
      state.newerCount += droppedTail;
    }
    if (droppedHead > 0) {
      sink.splice(0, droppedHead);
      state.olderCount += droppedHead;
    }

    return { droppedHead, droppedTail };
  }

  /**
   * Drop the oldest messages from the window, keeping the newest `keep`.
   *
   * Called once a save has landed, so everything dropped is on disk. That is
   * the whole reason writes are upserts: the window is not the conversation,
   * and forgetting part of it must not shorten the file.
   *
   * Returns how many were dropped.
   */
  function trimWindow(conversationId: string, keep: number): number {
    const state = conversationStates.value.get(conversationId);
    if (!state || keep <= 0) return 0;

    const sink = windowList(conversationId);
    if (!sink || sink.length <= keep) return 0;

    let drop = sink.length - keep;
    // Never into a turn still being written. Not only its streaming message:
    // a tool call waiting on its result is found by looking in the window
    // too, and a turn longer than `keep` reached back past its own start —
    // measured, a 601-message turn lost its first 101 at the first save after
    // the reader reached the end, results still to come for every one.
    if (windowReachesEnd(conversationId) && turnIsWriting(state, sink)) {
      const start = turnStartIn(state, sink);
      if (start === -1) return 0;
      drop = Math.min(drop, start);
    }
    if (drop <= 0) return 0;
    // A message still streaming has content arriving into it; dropping it
    // would strand that content. Never trim into the live tail.
    if (sink.slice(0, drop).some((m) => m.isStreaming)) return 0;

    sink.splice(0, drop);
    state.olderCount += drop;
    return drop;
  }

  /** How many stored messages precede the window on screen. */
  const olderMessageCount = computed(() => {
    const state = getCurrentState();
    return state?.olderCount ?? 0;
  });

  /**
   * How many of the conversation's messages come after what is on screen.
   *
   * `newerCount` is what is stored and not loaded; a detached turn is loaded
   * and not yet stored. Both are messages after the window that the reader
   * cannot see, so both are counted.
   */
  const newerMessageCount = computed(() => {
    const state = getCurrentState();
    if (!state) return 0;
    return state.newerCount + state.detachedTurn.length;
  });

  /** A turn written while the window did not reach the end, or null. */
  function detachedTurnFor(conversationId: string): ChatMessage[] | null {
    const detached = conversationStates.value.get(conversationId)?.detachedTurn;
    return detached && detached.length > 0 ? detached : null;
  }

  /**
   * A detached turn has been stored, so it is now simply what follows the
   * window — which is what `newerCount` counts.
   */
  function detachedTurnStored(conversationId: string): void {
    const state = conversationStates.value.get(conversationId);
    if (!state || state.detachedTurn.length === 0) return;
    // Still being written: a save mid-turn — switching away, opening a search
    // hit — stores it as far as it has got, and it is still where the rest of
    // it is going. Letting go of it here left the turn's next chunks and tool
    // results nothing to land in. It stays held, and uncounted among the
    // stored messages after the window, until a save after the turn ends.
    if (state.isLoading || state.detachedTurn.some((m) => m.isStreaming)) return;
    state.newerCount += state.detachedTurn.length;
    state.detachedTurn = [];
  }

  // ============================================
  // Loading State Actions
  // ============================================

  function setLoading(conversationId: string, loading: boolean): void {
    const state = getConversationState(conversationId);
    // A turn starts here: it is whatever follows the window's last message,
    // not counting the turn's own first message if sendMessage has already
    // started it.
    if (loading && !state.isLoading) {
      const list = windowList(conversationId) ?? [];
      const last = list.length - 1;
      const before = list[last]?.id === state.streamingMessageId ? last - 1 : last;
      state.turnAfter = { id: list[before]?.id ?? null };
    }
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

    const sink = messageSink(conversationId);
    if (sink) {
      for (let i = sink.length - 1; i >= 0; i--) {
        const msg = sink[i];
        if (msg.id === state.streamingMessageId) {
          // Off screen the streamed text accumulates in state rather than on
          // the message, so commit it before the stream is reset — otherwise
          // the text preceding this tool call is dropped from the history.
          if (conversationId !== currentConversationId.value && state.currentStreamingContent) {
            msg.content = state.currentStreamingContent;
          }
          if (msg.content.trim()) {
            msg.isStreaming = false;
          } else {
            sink.splice(i, 1);
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
    const sink = messageSink(conversationId);
    if (!sink) return;

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
    addMessageTo(sink, message);
  }

  /**
   * Insert an inline tool use message from a CLAUDE_TOOL_CAPTURE event.
   * These are emitted for ALL tools (including auto-approved ones).
   * Sets toolUseBlockId and input so the detail modal can show them.
   */
  /**
   * Intercept SDK Task* tool captures to reconstruct the model's todo list
   * client-side. TaskCreate inputs carry subject/description/activeForm but
   * no task ID yet — we key the entry by the tool_use block ID until the
   * result arrives with the real SDK-assigned ID.
   */
  function handleTaskListCapture(conversationId: string, capture: ToolCaptureData): void {
    const state = getConversationState(conversationId);
    const input = (capture.input || {}) as Record<string, unknown>;

    if (capture.toolName === 'TaskCreate') {
      const subject = typeof input.subject === 'string' ? input.subject : '';
      if (!subject) return;
      const item: TaskListItem = {
        id: capture.toolUseBlockId,
        subject,
        description: typeof input.description === 'string' ? input.description : undefined,
        activeForm: typeof input.activeForm === 'string' ? input.activeForm : undefined,
        status: 'pending',
        updatedAt: Date.now(),
      };
      state.taskListItems.set(capture.toolUseBlockId, item);
      logger.info('TaskList: create captured', { toolUseBlockId: capture.toolUseBlockId, subject });
    } else if (capture.toolName === 'TaskUpdate') {
      const taskId = typeof input.taskId === 'string' ? input.taskId : '';
      if (!taskId) return;
      const existing = state.taskListItems.get(taskId);
      if (!existing) {
        logger.warn('TaskList: update for unknown taskId', { taskId });
        return;
      }
      const next: TaskListItem = { ...existing, updatedAt: Date.now() };
      if (typeof input.subject === 'string') next.subject = input.subject;
      if (typeof input.description === 'string') next.description = input.description;
      if (typeof input.activeForm === 'string') next.activeForm = input.activeForm;
      if (typeof input.status === 'string' &&
          (input.status === 'pending' || input.status === 'in_progress' ||
           input.status === 'completed' || input.status === 'deleted')) {
        next.status = input.status;
      }
      state.taskListItems.set(taskId, next);
      logger.info('TaskList: update applied', { taskId, status: next.status });
    }
  }

  /**
   * Rebuild a conversation's task list from the Task* calls in its history.
   *
   * The list used to live only in this store, so restarting the app emptied
   * the panel while the work it described was still half done — and the model
   * kept its own copy, so the next `TaskUpdate` referred to tasks the panel no
   * longer knew and was dropped as unknown. Nothing wrote the list to disk,
   * and nothing read it back.
   *
   * MIGRATION ONLY — `restoreTaskList` is the real path. This runs for a
   * conversation saved before the list was persisted, where the Task* calls in
   * the transcript are the only evidence left. It is deliberately not the
   * primary mechanism, because it cannot promise the list back exactly: a
   * `TaskList` snapshot is unreplayable (only a path to its result is kept on
   * the message, not the content), and a create saved before `taskListId` was
   * stamped onto it cannot be matched to the updates that followed, so those
   * updates are skipped and the task keeps the status its create gave it.
   * Better than an empty panel on old history; not good enough to rely on,
   * which is why the list itself is now saved.
   *
   * Replayed rather than parsed: `handleTaskListCapture` is still the only
   * code that interprets a Task* input, called here with the saved input.
   *
   * Only ever applied to an EMPTY list, so a turn collecting in the background
   * — whose live items are ahead of anything saved — is never overwritten by
   * its own history.
   */
  /**
   * Put a saved task list back exactly as it was.
   *
   * The authoritative path, and the reason the list is saved at all: every
   * field the panel shows comes back verbatim — id, subject, description,
   * activeForm, status and the time it last changed — so a restart resumes on
   * the same list, at the same point, rather than on something reconstructed
   * that might differ. `deleted` items are kept too: they are invisible, but
   * their ids are how a later `TaskUpdate` resolves.
   *
   * Order is preserved because the panel renders the list in insertion order.
   *
   * Only applied to an empty list, so a turn already collecting in the
   * background — ahead of anything on disk — is never overwritten.
   */
  function restoreTaskList(conversationId: string, items: TaskListItem[] | undefined): boolean {
    if (!items || items.length === 0) return false;
    const state = getConversationState(conversationId);
    if (state.taskListItems.size > 0) return true;

    const restored = new Map<string, TaskListItem>();
    for (const item of items) {
      if (!item?.id) continue;
      restored.set(item.id, { ...item });
    }
    state.taskListItems = restored;
    logger.info('TaskList: restored from saved conversation', {
      conversationId,
      items: restored.size,
    });
    return true;
  }

  /** A conversation's task list as it stands, for saving. */
  function getTaskListItems(conversationId: string): TaskListItem[] {
    const state = conversationStates.value.get(conversationId);
    if (!state) return [];
    return Array.from(state.taskListItems.values()).map((item) => ({ ...item }));
  }

  function rebuildTaskList(conversationId: string, history: ChatMessage[]): void {
    const state = getConversationState(conversationId);
    if (state.taskListItems.size > 0) return;

    let replayed = 0;
    for (const message of history) {
      const toolUse = message.toolUse;
      if (!toolUse?.input) continue;
      if (toolUse.toolName !== 'TaskCreate' && toolUse.toolName !== 'TaskUpdate') continue;

      handleTaskListCapture(conversationId, {
        // A create is keyed by its SDK task id where that was recorded, so the
        // updates that follow find it. Without one it keeps the block id, as
        // it does in the live path before the result arrives.
        toolUseBlockId: toolUse.taskListId ?? toolUse.toolUseBlockId ?? toolUse.actionId,
        toolName: toolUse.toolName,
        input: toolUse.input,
        description: toolUse.description,
      });
      replayed += 1;
    }

    if (replayed > 0) {
      logger.info('TaskList: rebuilt from history', {
        conversationId,
        replayed,
        items: state.taskListItems.size,
      });
    }
  }

  /**
   * Remap the pending TaskCreate entry (keyed by tool_use block ID) to the
   * SDK-assigned task ID, once the main process has extracted it from the
   * tool_result. Deterministic — no JSON scraping on this side.
   */
  function rekeyPendingTask(conversationId: string, toolUseBlockId: string, taskId: string): void {
    const state = getConversationState(conversationId);
    const pending = state.taskListItems.get(toolUseBlockId);
    if (!pending) {
      logger.warn('TaskList: rekey requested but no pending entry', { toolUseBlockId, taskId });
      return;
    }
    state.taskListItems.delete(toolUseBlockId);
    state.taskListItems.set(taskId, { ...pending, id: taskId });
    logger.info('TaskList: pending entry rekeyed', { toolUseBlockId, taskId });
  }

  /**
   * Consume TaskList results — authoritative snapshot that overwrites local
   * state. TaskCreate remapping is handled deterministically via rekeyPendingTask.
   */
  function handleTaskListResult(conversationId: string, toolUseBlockId: string, content: string): void {
    const state = getConversationState(conversationId);
    logger.debug('TaskList: result seen', {
      toolUseBlockId,
      contentPreview: content.slice(0, 200),
    });
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { /* ignore */ }
      }
    }
    if (!parsed || typeof parsed !== 'object') return;

    const asRecord = parsed as Record<string, unknown>;
    const tasksField = asRecord.tasks as Array<{ id?: string; subject?: string; status?: string }> | undefined;
    if (Array.isArray(tasksField)) {
      // TaskList result — authoritative snapshot. Preserve local subject/desc
      // enrichment where possible; overwrite status from the snapshot.
      const next = new Map<string, TaskListItem>();
      for (const t of tasksField) {
        if (typeof t.id !== 'string') continue;
        const prev = state.taskListItems.get(t.id);
        const status = (t.status === 'pending' || t.status === 'in_progress' ||
                        t.status === 'completed' || t.status === 'deleted')
          ? t.status
          : 'pending';
        next.set(t.id, {
          id: t.id,
          subject: typeof t.subject === 'string' ? t.subject : (prev?.subject ?? ''),
          description: prev?.description,
          activeForm: prev?.activeForm,
          status,
          updatedAt: Date.now(),
        });
      }
      state.taskListItems = next;
    }
  }

  function addAutoToolUseMessage(conversationId: string, capture: ToolCaptureData): void {
    const sink = messageSink(conversationId);
    if (!sink) return;

    splitStreamingForTool(conversationId);

    handleTaskListCapture(conversationId, capture);

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
    addMessageTo(sink, message);

    // Dedupe: if a backgroundTask inline message already exists for this
    // tool_use (e.g. task_started arrived before the assistant message
    // carrying the tool_use block), remove it — the tool_use indicator now
    // represents that task in the chat.
    removeBackgroundTaskMessageByToolUseId(conversationId, sink, capture.toolUseBlockId);
  }

  /**
   * Remove an inline backgroundTask message whose underlying task is tied
   * to the given tool_use ID. Background task still tracked in the Map.
   */
  function removeBackgroundTaskMessageByToolUseId(
    conversationId: string,
    sink: ChatMessage[],
    toolUseId: string,
  ): void {
    const state = conversationStates.value.get(conversationId);
    if (!state) return;

    let linkedTaskId: string | null = null;
    for (const [id, task] of state.backgroundTasks.entries()) {
      if (task.toolUseId === toolUseId) {
        linkedTaskId = id;
        break;
      }
    }
    if (!linkedTaskId) return;

    for (let i = sink.length - 1; i >= 0; i--) {
      const msg = sink[i];
      if (msg.backgroundTask?.taskId === linkedTaskId) {
        sink.splice(i, 1);
        return;
      }
    }
  }

  /**
   * Enrich an existing capture-created ToolUseMessage with the real actionId
   * from a permission prompt. Falls back to creating a new message if no capture match.
   *
   * Matching strategy: oldest capture-created entry of the same toolName that
   * has not yet been enriched (actionId still equals toolUseBlockId). We do NOT
   * compare input JSON — equivalent objects can serialize differently after
   * IPC because key order isn't preserved across structuredClone for deeply
   * nested payloads (real-world repro: AskUserQuestion's questions[].options[]
   * would mismatch, the fallback fired, and a duplicate inline indicator was
   * created — one from auto-capture, one from permission). The SDK pairs each
   * tool_use block with one canUseTool call in FIFO order, so the oldest
   * unenriched capture of this toolName is this call.
   */
  function enrichToolUseFromPermission(conversationId: string, action: PendingAction): void {
    const sink = messageSink(conversationId);
    if (!sink) return;

    for (let i = 0; i < sink.length; i++) {
      const msg = sink[i];
      if (
        msg.toolUse &&
        msg.toolUse.toolUseBlockId &&
        msg.toolUse.actionId === msg.toolUse.toolUseBlockId &&
        msg.toolUse.toolName === action.toolName
      ) {
        msg.toolUse = {
          ...msg.toolUse,
          actionId: action.id,
          description: action.description || msg.toolUse.description,
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
   * Also marks auto-approved tools as executed, and forwards small inline
   * content to the task-list handler when relevant.
   */
  function updateToolUseResult(conversationId: string, result: ToolResultData): void {
    const sink = messageSink(conversationId);
    if (!sink) return;

    if (result.taskListId) {
      rekeyPendingTask(conversationId, result.toolUseBlockId, result.taskListId);
    }
    if (result.content !== undefined) {
      handleTaskListResult(conversationId, result.toolUseBlockId, result.content);
    }

    for (let i = sink.length - 1; i >= 0; i--) {
      const msg = sink[i];
      if (msg.toolUse?.toolUseBlockId === result.toolUseBlockId) {
        const newStatus: ToolUseInfo['status'] =
          msg.toolUse.status === 'approved' ? 'executed' : msg.toolUse.status;
        msg.toolUse = {
          ...msg.toolUse,
          outputFile: result.outputFile,
          status: newStatus,
          // Kept on the message because the message is what gets saved: the
          // task list is rebuilt from these calls on load, and an update
          // refers to its task by this id. See rebuildTaskList.
          ...(result.taskListId ? { taskListId: result.taskListId } : {}),
        };
        // Images the tool produced go on the MESSAGE, not inside toolUse:
        // they are the result's content as far as the reader is concerned,
        // and a message is where the transcript draws things. References
        // only — the bytes are in the image store, fetched when drawn.
        if (result.images && result.images.length > 0) {
          msg.images = [...(msg.images ?? []), ...result.images];
        }
        if (newStatus === 'executed') {
          trackModificationsFor(conversationId, msg.toolUse);
        }
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
    const sink = messageSink(conversationId);
    if (!sink) return;

    const msg = sink.find((m) => m.toolUse?.actionId === actionId);
    if (msg?.toolUse) {
      msg.toolUse.status = status;
      if (status === 'executed') {
        trackModificationsFor(conversationId, msg.toolUse);
      }
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

  /**
   * Classify a background task as 'agent' or 'command' by looking up the parent
   * tool_use it was spawned from. Task/Agent tool → agent; anything else (Bash
   * with run_in_background, absence of a match) → command.
   */
  function resolveTaskType(conversationId: string, toolUseId?: string): 'agent' | 'command' {
    if (!toolUseId) return 'command';
    const sink = messageSink(conversationId);
    if (!sink) return 'command';
    for (const m of sink) {
      if (m.toolUse?.toolUseBlockId === toolUseId) {
        const name = m.toolUse.toolName;
        return name === 'Task' || name === 'Agent' ? 'agent' : 'command';
      }
    }
    return 'command';
  }

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

    // If no direct match, match a running task by description — but only when
    // exactly one has it.
    //
    // This covers task_started having used the tool_use id while the
    // completion uses the SDK's own, where the description is the only field
    // the two share. It used to take the FIRST running task with a matching
    // description, which is a guess as soon as two tasks share one — the same
    // command run twice, or the same agent prompt — and it retired one of them
    // arbitrarily while it was still working.
    //
    // One match is evidence. More than one is not, and `background_tasks_changed`
    // retires whatever really ended, so declining to guess costs only
    // timeliness.
    if (!existingTask && notification.status !== 'running' && notification.description) {
      const described = [...state.backgroundTasks.entries()].filter(
        ([, task]) =>
          task.status === 'running' && task.description === notification.description,
      );
      if (described.length === 1) {
        [existingTaskId, existingTask] = described[0];
      }
    }

    // Fallback: a completion for an id we do not track, with exactly one task
    // running, is that task.
    //
    // It covers a real case — the tool_use id → task id remapping not reaching
    // the renderer, which would otherwise leave the task 'running' forever.
    // But it used to pick the OLDEST running task whenever there was more than
    // one, which is a guess with nothing behind it: with two tasks going, an
    // unknown completion retired whichever had started first, and a task still
    // working disappeared from the panel. Reported as the list of background
    // tasks sometimes losing entries.
    //
    // With more than one running there is no evidence to choose, so nothing is
    // retired here. That is safe now in a way it may not have been when this
    // was written: `background_tasks_changed` carries the authoritative live
    // set with REPLACE semantics, so a task that really ended is retired by
    // `reconcileBackgroundTasks` — late rather than wrongly.
    if (!existingTask && notification.status !== 'running') {
      const running = [...state.backgroundTasks.entries()].filter(
        ([, task]) => task.status === 'running',
      );
      if (running.length === 1) {
        [existingTaskId, existingTask] = running[0];
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
        // Why this task is in the panel at all, when its command had a
        // timeout: the timeout is what backgrounded it. Kept so the detail
        // view can say so.
        ...(typeof notification.timedOutAfterMs === 'number'
          ? { timedOutAfterMs: notification.timedOutAfterMs }
          : {}),
      };

      // `completedAt` is what the duration is measured to, so it has to track
      // the status in BOTH directions. Only ever setting it meant a task that
      // reported a terminal status and then went on reporting progress — a
      // misattributed completion, which the fallback above can still produce
      // when it is the only running task — kept the stamp from that moment.
      // It then sat in the panel listed as running with a duration frozen at
      // the instant of the wrong notification.
      if (notification.status === 'running') {
        delete updatedTask.completedAt;
      } else {
        updatedTask.completedAt = Date.now();
      }

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
        ...(typeof notification.timedOutAfterMs === 'number'
          ? { timedOutAfterMs: notification.timedOutAfterMs }
          : {}),
        // Falls back to the task id, because a backgrounded tool's first
        // notification sends its tool_use block id as `taskId` and sets no
        // `toolUseId`. Keying only on toolUseId classified every background
        // task as a plain command, including backgrounded agents.
        taskType: resolveTaskType(conversationId, notification.toolUseId ?? notification.taskId),
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
    const sink = messageSink(conversationId);
    if (!sink) return false;
    for (const m of sink) {
      if (m.toolUse?.toolUseBlockId === toolUseBlockId) return true;
    }
    return false;
  }

  /**
   * Insert an inline background task message into the message stream.
   */
  function addBackgroundTaskMessage(conversationId: string, task: BackgroundTask): void {
    const sink = messageSink(conversationId);
    if (!sink) return;

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
        // Carried so this row can act as the parent for tool calls the task
        // makes. They reference the spawning tool_use id, and when no message
        // provides it they are orphaned and end up in the main conversation.
        ...(task.toolUseId && { toolUseId: task.toolUseId }),
      },
    };
    addMessageTo(sink, message);
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
    const sink = messageSink(conversationId);
    if (!sink) return;

    const msg = sink.find((m) => m.backgroundTask?.taskId === taskId);
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


  /**
   * Mark all in-flight tool use messages as 'executed'.
   * Called when a query completes to ensure no tool use spinners linger.
   */
  function completeToolUseMessages(conversationId: string): void {
    const sink = messageSink(conversationId);
    if (!sink) return;

    for (const msg of sink) {
      if (msg.toolUse && (msg.toolUse.status === 'pending' || msg.toolUse.status === 'approved')) {
        msg.toolUse.status = 'executed';
        trackModificationsFor(conversationId, msg.toolUse);
      }
    }
  }

  /**
   * Reconcile tracked background tasks against the SDK's authoritative live
   * set, which arrives with REPLACE semantics.
   *
   * The incremental notifications are the normal path and carry the real
   * outcome, so this only has to resolve what they missed. Anything missed
   * previously stayed 'running' forever — nothing else in the app ever
   * revisited a task's status, which is how a finished task came to sit in the
   * panel with a duration of 27 hours.
   *
   * Two steps, in order:
   *
   *   1. Adopt: a live task we track under a different key — the pre-remap
   *      tool_use id, most often — is re-keyed to the SDK's id, so step 2 does
   *      not mistake it for one that ended.
   *   2. Retire: a running task absent from the live set is no longer running.
   *      It is marked 'stopped' rather than 'completed' because the live list
   *      says only that the task is gone, not that it succeeded; claiming
   *      success would be inventing an outcome.
   *
   * Ambient tasks (watchers, skip_transcript) count as live for step 2 so a
   * task of ours matching one is never retired, but are not adopted as new
   * visible entries — the SDK asks hosts to keep them out of activity
   * indicators.
   */
  function reconcileBackgroundTasks(conversationId: string, live: LiveBackgroundTask[]): void {
    const state = conversationStates.value.get(conversationId);
    if (!state) return;

    const liveIds = new Set(live.map(t => t.taskId));

    // Step 1 — adopt live tasks tracked under a stale key.
    for (const liveTask of live) {
      if (state.backgroundTasks.has(liveTask.taskId)) continue;

      // Match on description, the only field shared between a locally created
      // entry and the live list. Restricted to running entries whose id is not
      // itself live, so an adopted key is never stolen from another task.
      let staleKey: string | null = null;
      for (const [key, task] of state.backgroundTasks.entries()) {
        if (task.status !== 'running') continue;
        if (liveIds.has(key)) continue;
        if (task.description && task.description === liveTask.description) {
          staleKey = key;
          break;
        }
      }
      if (staleKey === null) continue;

      const adopted = state.backgroundTasks.get(staleKey)!;
      state.backgroundTasks.delete(staleKey);
      state.backgroundTasks.set(liveTask.taskId, { ...adopted, id: liveTask.taskId });
      liveIds.add(liveTask.taskId);
    }

    // Step 2 — retire running tasks the SDK no longer lists.
    for (const [key, task] of state.backgroundTasks.entries()) {
      if (task.status !== 'running' || liveIds.has(key)) continue;
      state.backgroundTasks.set(key, {
        ...task,
        status: 'stopped',
        completedAt: task.completedAt ?? Date.now(),
      });
    }
  }

  // ============================================
  // Session Usage Actions
  // ============================================

  /**
   * Record the main-loop model the CLI reports for a conversation. Kept
   * separate from usage accounting: a turn's modelUsage legitimately includes
   * the small-fast model, so deriving "the model" from it named Haiku on
   * conversations pinned to Opus.
   */
  function setActiveModel(conversationId: string, model: string): void {
    const state = getConversationState(conversationId);
    state.activeModel = model || null;
  }

  /**
   * Accumulate a sub-agent frame's model and token spend onto the background
   * task that spawned it, matched by the spawning tool_use ID. Kept per-agent
   * rather than folded into the conversation totals so an agent's detail view
   * can answer "what did this run on, and what did it cost".
   */
  function recordSubagentActivity(
    conversationId: string,
    activity: { parentToolUseId: string; model?: string; inputTokens: number; outputTokens: number },
  ): void {
    const state = getConversationState(conversationId);
    for (const task of state.backgroundTasks.values()) {
      if (task.toolUseId !== activity.parentToolUseId) continue;
      if (activity.model) task.model = activity.model;
      task.inputTokens = (task.inputTokens ?? 0) + activity.inputTokens;
      task.outputTokens = (task.outputTokens ?? 0) + activity.outputTokens;
      return;
    }
  }

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

  /**
   * Make the per-conversation busy flags agree with the main process.
   *
   * The main process owns the truth here — `processingSessions`, which it
   * emits on every change — and this is the only thing that corrects drift.
   * `isLoading` is otherwise set optimistically when a message is sent and
   * cleared by CLAUDE_DONE, so a done that is missed, duplicated, or
   * attributed to a different turn leaves a conversation's activity indicator
   * wrong for the rest of the session. With two conversations in flight that
   * showed up as exactly the reported pair of symptoms: one conversation kept
   * its spinner after finishing, the other lost it while still running.
   *
   * State is created for a listed conversation that has none, because a
   * conversation can be running without ever having been opened in this
   * session — and the indicator reads that state.
   *
   * One deliberate looseness: a conversation can briefly be absent here
   * between the renderer optimistically marking it busy and the main process
   * registering it. The next emit — which the main process sends as soon as it
   * registers — puts it back, so the window is a few milliseconds.
   */
  function reconcileActiveConversations(ids: string[]): void {
    activeConversationIds.value = ids;
    const active = new Set(ids);

    for (const [conversationId, state] of conversationStates.value) {
      if (state.isLoading && !active.has(conversationId)) {
        state.isLoading = false;
      }
    }

    for (const conversationId of active) {
      getConversationState(conversationId).isLoading = true;
    }
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

  /**
   * Record the files a tool call changed, once it has actually run.
   *
   * Called from every point where a tool use reaches 'executed', which is
   * what makes this cover auto-approved writes. The previous single caller
   * was the permission-prompt Approve branch, so anything auto-approved —
   * every write after an "always allow", everything under acceptEdits or
   * bypassPermissions — was never recorded and the indicator appeared on a
   * fraction of the files that had changed.
   *
   * Keyed on execution rather than invocation so a denied or failed call does
   * not mark a file that was never written.
   */
  function trackModificationsFor(conversationId: string, toolUse: ToolUseInfo): void {
    for (const path of modifiedPathsForTool(toolUse.toolName, toolUse.input)) {
      trackFileModification(conversationId, path);
    }
  }

  /**
   * Record a filesystem change the watcher observed.
   *
   * Covers what the tool inputs cannot: a file written by a shell command.
   * `Bash` can write anywhere and its targets are not derivable from the
   * command line without interpreting it, so `rm`, `sed -i`, a formatter or a
   * build step would otherwise never appear in the indicator.
   *
   * Attributed only to conversations with a query in flight. Without that
   * gate every save in the user's own editor, and every background process
   * touching the tree, would mark files as though Claude had changed them —
   * which is worse than the under-reporting this fixes, because it cannot be
   * distinguished from a real edit.
   *
   * When two conversations are running at once a change is attributed to
   * both: the watcher reports a path, not a cause, and guessing one owner
   * would be invention. Over-attribution between two concurrently running
   * queries is the honest answer.
   */
  function trackWatcherModification(path: string): void {
    for (const state of conversationStates.value.values()) {
      if (!state.isLoading) continue;
      state.modifiedFilesInLastQuery.add(path);
    }
  }

  function clearModifiedFiles(conversationId: string): void {
    const state = conversationStates.value.get(conversationId);
    if (state) {
      state.modifiedFilesInLastQuery = new Set();
    }
  }

  // ============================================
  // Queued Prompt Actions
  // ============================================

  /**
   * Hold a prompt until the running turn finishes.
   *
   * Empty input is rejected here as well as at the call site, so the queue
   * cannot acquire an entry that `sendMessage` would later refuse to send and
   * which the user would then have to clear by hand.
   */
  function queuePrompt(conversationId: string, content: string): QueuedPrompt | null {
    const trimmed = content.trim();
    if (!trimmed) return null;

    const prompt: QueuedPrompt = {
      id: generateId(ID_PREFIXES.QUEUED_PROMPT),
      content: trimmed,
      queuedAt: Date.now(),
    };
    getConversationState(conversationId).queuedPrompts.push(prompt);
    return prompt;
  }

  /**
   * Remove and return the oldest queued prompt.
   *
   * Taking it out before it is sent, rather than after, so a send that throws
   * cannot leave the same prompt queued *and* in the transcript — it would be
   * sent again at the end of the next turn.
   */
  function takeNextQueuedPrompt(conversationId: string): QueuedPrompt | null {
    const state = conversationStates.value.get(conversationId);
    return state?.queuedPrompts.shift() ?? null;
  }

  /** Drop one queued prompt, for the remove button on its chip. */
  function removeQueuedPrompt(conversationId: string, promptId: string): void {
    const state = conversationStates.value.get(conversationId);
    if (!state) return;
    const index = state.queuedPrompts.findIndex((p) => p.id === promptId);
    if (index !== -1) state.queuedPrompts.splice(index, 1);
  }

  /** Drop every queued prompt for a conversation. */
  function clearQueuedPrompts(conversationId: string): void {
    const state = conversationStates.value.get(conversationId);
    if (state) state.queuedPrompts = [];
  }

  /** Put a prompt back at the front, after a send failed to start a turn. */
  function restoreQueuedPrompt(conversationId: string, prompt: QueuedPrompt): void {
    getConversationState(conversationId).queuedPrompts.unshift(prompt);
  }

  /** Stop releasing queued prompts by themselves until the user says so. */
  function holdQueuedPrompts(conversationId: string): void {
    getConversationState(conversationId).queueHeld = true;
  }

  /** Resume releasing queued prompts automatically. */
  function releaseQueueHold(conversationId: string): void {
    const state = conversationStates.value.get(conversationId);
    if (state) state.queueHeld = false;
  }

  function isQueueHeld(conversationId: string): boolean {
    return conversationStates.value.get(conversationId)?.queueHeld ?? false;
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
    taskListItems,
    hasTaskListItems,
    olderMessageCount,
    newerMessageCount,
    detachedTurnFor,
    detachedTurnStored,
    absorbDetachedTurn,
    windowHoldsLiveTurn,
    detachLiveTurn,
    unwrittenMessagesFor,
    unwrittenByConversation,
    windowReachesEnd,
    hasSessionUsage,
    activeModel,
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
    addAssistantMessage,
    addSystemMessage,
    recordUserTurnUuid,
    truncateAfterUserTurn,
    pendingTruncationFor,
    clearPendingTruncation,
    setTailPinned,
    isTailPinned,
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
    beginMessageBuffer,
    getBufferedMessages,
    retainUnsavedMessages,
    endMessageBuffer,
    reconcileBackgroundTasks,
    completeToolUseMessages,

    // Message window actions
    prependOlderMessages,
    appendNewerMessages,
    trimWindow,
    trimWindowAround,

    // Task list actions
    restoreTaskList,
    rebuildTaskList,
    getTaskListItems,

    // Session usage actions
    setActiveModel,
    recordSubagentActivity,
    updateSessionUsage,
    clearSessionUsage,

    // Resource tracking
    updateActiveQueries,
    updateActiveConversationIds,
    reconcileActiveConversations,

    // Session permission actions
    updateSessionPermissions,

    // Modified files tracking
    modifiedFilesInLastQuery,
    trackFileModification,
    trackWatcherModification,
    clearModifiedFiles,

    // Prompts written while a turn was running
    queuedPrompts,
    queuePrompt,
    takeNextQueuedPrompt,
    removeQueuedPrompt,
    clearQueuedPrompts,
    restoreQueuedPrompt,
    holdQueuedPrompts,
    releaseQueueHold,
    isQueueHeld,
    queueHeld,

    // Cleanup
    clearConversationState,
    resetAllConversationStates,
  };
});
