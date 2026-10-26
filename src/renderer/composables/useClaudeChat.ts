/**
 * Composable for Claude chat functionality
 *
 * IMPORTANT: IPC listeners are registered as a singleton to prevent
 * duplicate message processing when multiple components use this composable.
 *
 * Updated for multi-conversation support - all events now include conversationId
 * for proper routing to per-conversation state.
 */

import { effectScope, onMounted, onUnmounted, shallowRef, watch, type EffectScope } from 'vue';

import type { AskUserQuestionAnswer, AskUserQuestionResponse, SlashCommandInfo, ChatMessage, MessageImage, PermissionScope } from '@shared/types';

import { CONSTANTS } from '../constants/app';
import { useChatStore } from '../stores/chat';
import { useConversationsStore } from '../stores/conversations';
import { useFilesStore } from '../stores/files';
import { useSettingsStore } from '../stores/settings';
import { logger } from '../utils/logger';
import { nextFlush } from '../utils/prompt-queue';
import {
  USAGE_LIMIT_CHECK_INTERVAL_MS,
  USAGE_LIMIT_CONTINUE_PROMPT,
  scheduleWait,
  waitForStop,
} from '../utils/usage-limit';

import { useSlashCommands } from './useSlashCommands';

// Singleton state for IPC listeners - shared across all composable instances
// This prevents duplicate listener registration when multiple components use this composable
let listenersRegistered = false;
let listenerRefCount = 0;
/** Scope holding the queue re-check watcher, shared like the listeners. */
let queueScope: EffectScope | null = null;
/** Conversations with a flush in progress, so two cannot both send. */
const flushing = new Set<string>();
/** Conversations with a continue after a usage limit in progress. */
const continuing = new Set<string>();
/** Polls for a scheduled continue that is due; runs only while one exists. */
let usageLimitTimer: ReturnType<typeof setInterval> | null = null;
let cleanupUsageLimit: (() => void) | null = null;
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
  /**
   * What became of a send.
   *
   * `sendMessage` used to return nothing, and every caller simply hoped. The
   * queue needs to tell three outcomes apart: a turn is now running, so the
   * next queued prompt waits for it; the prompt was a command this GUI answers
   * itself, so no turn is coming and the queue should carry straight on; or it
   * was refused, so the prompt must go back in the queue rather than vanish.
   */
  type SendOutcome = 'started' | 'handled' | 'rejected';

  async function sendMessage(content: string, images?: MessageImage[]): Promise<SendOutcome> {
    // Attachments alone are a message: a screenshot with no question is a
    // real thing to send, and refusing it would make an attachment useless
    // without something typed next to it.
    if (!content.trim() && (!images || images.length === 0)) {
      return 'rejected';
    }

    const currentConvId = conversationsStore.currentConversationId;
    if (!currentConvId) {
      chatStore.setError(currentConvId || 'unknown', 'No active conversation');
      return 'rejected';
    }

    // Check prerequisites
    if (!settingsStore.hasAuth) {
      chatStore.setError(currentConvId, 'Please log in or configure your API key in Settings');
      return 'rejected';
    }

    if (!filesStore.workingDirectory) {
      chatStore.setError(currentConvId, 'Please select a working directory');
      return 'rejected';
    }

    // Check resource limits
    if (chatStore.isAtResourceLimit && !chatStore.isConversationLoading(currentConvId)) {
      chatStore.setError(
        currentConvId,
        `Maximum concurrent runs (${chatStore.maxConcurrentQueries}) reached. ` +
        `Please wait for another conversation's current turn to finish or cancel it.`
      );
      return 'rejected';
    }

    // Clear any previous error and modified files from last query
    chatStore.clearError();
    chatStore.clearModifiedFiles(currentConvId);

    // Add user message to chat
    chatStore.addUserMessage(content, images);

    // Commands this GUI answers itself stop here: the prompt is never sent, no
    // turn is started and no tokens are spent. The user's message is added
    // first so the transcript reads as a normal exchange — and so /clear wipes
    // its own invocation along with everything else.
    if (await handleSlashCommand(content)) {
      return 'handled';
    }

    return startTurn(currentConvId, content, images);
  }

  /**
   * Send a prompt whose user message is already in the transcript, and run
   * the turn that answers it.
   *
   * The half of a send that does not care whether the conversation is the one
   * on screen: everything here is keyed by conversation and writes through
   * its message sink. Shared by `sendMessage` and the continue after a usage
   * limit, which is the one turn that starts while the user may be looking at
   * a different conversation.
   */
  async function startTurn(conversationId: string, content: string, images?: MessageImage[]): Promise<SendOutcome> {
    // Start assistant message for streaming - pass conversation ID for proper tracking
    chatStore.startAssistantMessage(conversationId);
    chatStore.setLoading(conversationId, true);

    // Start buffering for this conversation, seeded with what is on screen, so
    // it keeps building a complete history if the user switches away mid-turn.
    chatStore.beginMessageBuffer(conversationId);

    // Any turn ends a wait for a usage limit to reset: it is either the
    // continue itself, or the user taking over from it.
    chatStore.setUsageLimitWait(conversationId, null);

    try {
      // Get SDK session ID for this conversation (for resume support)
      const resumeSessionId = conversationsStore.getSdkSessionId(conversationId);

      // When resuming, use the conversation's stored CWD — the CLI stores session
      // files under a CWD-derived path, so it must match the original creation CWD.
      // Fall back to current global CWD for new conversations or if not available.
      // A conversation off screen is not the one the global CWD belongs to, so
      // it uses its own whenever it has one.
      const ownCwd = !!resumeSessionId || conversationId !== conversationsStore.currentConversationId;
      const effectiveCwd = ownCwd
        ? (conversationsStore.getConversationWorkingDirectory(conversationId) || filesStore.workingDirectory)
        : filesStore.workingDirectory;

      logger.info('Sending message to Claude', {
        conversationId,
        hasResumeSession: !!resumeSessionId,
        cwd: effectiveCwd,
        cwdMatchesGlobal: effectiveCwd === filesStore.workingDirectory,
      });

      // Send message via IPC with conversationId and optional resume session ID.
      // The images go as plain copies: callers hand over the composer's
      // reactive state, and Electron cannot copy a reactive proxy across the
      // process boundary, so the send threw here before main ever saw it.
      const plainImages = images?.map((image) => ({ ...image }));
      await window.electron.claude.send(conversationId, content, effectiveCwd, resumeSessionId, plainImages);
      // New work means the user has moved past whatever stopped the queue, so
      // queued prompts go back to releasing on their own.
      chatStore.releaseQueueHold(conversationId);
      return 'started';
    } catch (err) {
      logger.error('Failed to send message', err);
      chatStore.setError(conversationId, 'Failed to send message to Claude');
      chatStore.setLoading(conversationId, false);
      return 'rejected';
    }
  }

  /**
   * Continue a task a usage limit stopped, with the prompt the CLI uses.
   *
   * Runs when the scheduled time comes, or when the user asks for it now. The
   * conversation may not be the one on screen — the reset comes when it comes
   * — so this does what `sendMessage` would, keyed by conversation, and gives
   * a conversation that holds nothing in memory the tail of its history to
   * write the turn into.
   */
  async function continueAfterUsageLimit(conversationId: string): Promise<void> {
    // The poll can find the same wait due again while this one is still
    // loading history; two continues would be two turns.
    if (continuing.has(conversationId)) return;
    continuing.add(conversationId);
    try {
      const wait = chatStore.getConversationState(conversationId).usageLimitWait;
      if (!wait) return;

      if (chatStore.isConversationLoading(conversationId)) {
        // A turn is already running, so there is nothing left to continue.
        chatStore.setUsageLimitWait(conversationId, null);
        return;
      }

      if (chatStore.isAtResourceLimit) {
        // Not an error: the wait stays scheduled and the next check retries.
        logger.debug('Continue after usage limit waits for room under the run cap', { conversationId });
        return;
      }

      if (!settingsStore.hasAuth) {
        chatStore.setUsageLimitWait(conversationId, null);
        chatStore.setError(conversationId, 'Could not continue after the usage limit reset: please log in or configure your API key in Settings');
        return;
      }

      if (!chatStore.hasMessageSink(conversationId)) {
        const window_ = await window.electron.conversation.getWindow(
          conversationId,
          CONSTANTS.CONVERSATION.WINDOW_SIZE,
        );
        if (!window_) {
          logger.warn('Conversation to continue after usage limit no longer exists', { conversationId });
          chatStore.setUsageLimitWait(conversationId, null);
          return;
        }
        chatStore.seedBackgroundWindow(conversationId, window_.conversation.messages, window_.olderCount);
      }

      logger.info('Continuing after usage limit reset', {
        conversationId,
        resetsAt: new Date(wait.resetsAt).toISOString(),
        isCurrent: conversationId === conversationsStore.currentConversationId,
      });
      chatStore.setError(conversationId, null);
      chatStore.clearModifiedFiles(conversationId);
      chatStore.addUserMessage(USAGE_LIMIT_CONTINUE_PROMPT, undefined, conversationId);
      await startTurn(conversationId, USAGE_LIMIT_CONTINUE_PROMPT);
    } finally {
      continuing.delete(conversationId);
    }
  }

  /** Continue the current conversation's stopped task now, without waiting. */
  async function continueUsageLimitNow(): Promise<void> {
    const conversationId = conversationsStore.currentConversationId;
    if (conversationId) await continueAfterUsageLimit(conversationId);
  }

  /** Schedule the current conversation's continue, when the reset allows. */
  function scheduleUsageLimitContinue(): void {
    const conversationId = conversationsStore.currentConversationId;
    const wait = chatStore.usageLimitWait;
    if (!conversationId || !wait) return;
    const scheduled = scheduleWait(wait, Date.now());
    if (scheduled) chatStore.setUsageLimitWait(conversationId, scheduled);
  }

  /** Unschedule the current conversation's continue, keeping the wait on offer. */
  function cancelUsageLimitContinue(): void {
    const conversationId = conversationsStore.currentConversationId;
    const wait = chatStore.usageLimitWait;
    if (!conversationId || !wait) return;
    chatStore.setUsageLimitWait(conversationId, { ...wait, resumeAt: null });
  }

  /** Forget the current conversation's usage-limit stop altogether. */
  function dismissUsageLimit(): void {
    const conversationId = conversationsStore.currentConversationId;
    if (conversationId) chatStore.setUsageLimitWait(conversationId, null);
  }

  /**
   * Hold a prompt until the running turn finishes.
   *
   * The alternative the user had was to press Stop, which aborts the run and
   * every agent inside it, just to be able to say the next thing.
   */
  function queuePrompt(content: string): void {
    const currentConvId = conversationsStore.currentConversationId;
    if (!currentConvId || !content.trim()) return;

    chatStore.queuePrompt(currentConvId, content);
    logger.info('Prompt queued for the end of the current turn', {
      conversationId: currentConvId,
      queued: chatStore.queuedPrompts.length,
    });
  }

  /**
   * Release queued prompts, as far as the conditions allow.
   *
   * Called when a turn ends. `nextFlush` owns the rules and is tested on its
   * own; this is the side effects.
   *
   * It is a loop rather than a single step because of commands this GUI
   * answers itself: `/help` starts no turn, so there is no later event to
   * resume the queue from, and stopping after one would leave the rest stuck
   * until the user happened to run another query. Each pass removes an entry,
   * so it ends — on a started turn, on a hold, or on an empty queue.
   */
  async function flushQueuedPrompts(conversationId: string): Promise<void> {
    // One flush per conversation at a time. The queue is re-examined from
    // several places now — a turn ending, and a watcher on the conditions
    // that gate it — and two of them landing together would each take a
    // prompt and start a turn with it.
    if (flushing.has(conversationId)) return;
    flushing.add(conversationId);
    try {
    for (;;) {
      const state = chatStore.getConversationState(conversationId);
      const decision = nextFlush({
        conversationId,
        currentConversationId: conversationsStore.currentConversationId,
        queue: state.queuedPrompts,
        isLoading: chatStore.isConversationLoading(conversationId),
        atResourceLimit: chatStore.isAtResourceLimit,
        held: state.queueHeld,
      });

      if (decision.kind === 'hold') {
        if (decision.reason !== 'empty') {
          logger.info('Queued prompts held', {
            conversationId,
            reason: decision.reason,
            queued: state.queuedPrompts.length,
          });
        }
        return;
      }

      const prompt = chatStore.takeNextQueuedPrompt(conversationId);
      if (!prompt) return;

      logger.info('Sending queued prompt', { conversationId, promptId: prompt.id });
      const outcome = await sendMessage(prompt.content);

      if (outcome === 'rejected') {
        // Refused before a turn began — no auth, no working directory, the
        // cap reached since the check. Put it back rather than lose what the
        // user wrote; the reason is already in the transcript as an error.
        logger.warn('Queued prompt was refused — returning it to the queue', {
          conversationId,
          promptId: prompt.id,
        });
        chatStore.restoreQueuedPrompt(conversationId, prompt);
        return;
      }

      // A turn is now running; the rest of the queue waits for it to finish.
      if (outcome === 'started') return;
    }
    } finally {
      flushing.delete(conversationId);
    }
  }

  /**
   * Send the queued prompts now, at the user's request.
   *
   * Needed because not every hold has a later event to release it. Stopping a
   * turn is the clearest case: the abort is honoured — nothing is sent behind
   * the user's back — but then no turn will ever end for this conversation, so
   * without this the queue would sit there with no way forward but deleting
   * it. Same for a turn that errored, and for the concurrent-run cap.
   */
  async function releaseQueuedPrompts(): Promise<void> {
    const currentConvId = conversationsStore.currentConversationId;
    if (!currentConvId) return;
    // The explicit ask is what clears a hold; nothing else does, apart from
    // starting a new turn.
    chatStore.releaseQueueHold(currentConvId);
    await flushQueuedPrompts(currentConvId);
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

    // Stopping is a request for the app to stop working, so the queue must
    // not release by itself afterwards. Set before the abort, so the loading
    // flag dropping cannot race the re-check into sending something.
    chatStore.holdQueuedPrompts(currentConvId);

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
    chatStore.holdQueuedPrompts(conversationId);
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
   * Store a background task's outcome as soon as it is known.
   *
   * A task usually ends after the turn that started it, and that turn's save
   * has already recorded its row as running. Nothing else saved the
   * conversation until the user next did something in it, so quitting first
   * left the row stored as running for good.
   *
   * Only for the conversation on screen: one off screen holds its rows on
   * disk, not in memory, so saving would write nothing of them — and the save
   * at hand is the current conversation's, which would be a pointless write
   * of another one.
   */
  function storeTaskOutcome(conversationId: string): void {
    if (conversationId !== conversationsStore.currentConversationId) return;
    conversationsStore.saveCurrentConversation().catch((err) => {
      logger.error('Failed to save a background task outcome', err);
    });
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

    // Re-examine the queue whenever the conditions that gate it change.
    //
    // Without this the only thing that released a queued prompt was a turn
    // ending, so every other hold was permanent: a queue belonging to a
    // conversation the user had switched away from stayed held when they came
    // back, because returning is not an event the turn-end handler ever sees,
    // and the same went for room appearing under the concurrent-run cap. The
    // prompts sat there forever with nothing to release them.
    //
    // In a detached scope, not the calling component's: the listeners it
    // belongs with are a singleton shared by every instance, so binding this
    // to whichever component happened to register them would stop it the
    // moment that one unmounted while the others carried on.
    queueScope = effectScope(true);
    queueScope.run(() => {
      watch(
        () => {
          const id = conversationsStore.currentConversationId;
          return [
            id,
            id ? chatStore.isConversationLoading(id) : false,
            chatStore.isAtResourceLimit,
          ] as const;
        },
        () => {
          const id = conversationsStore.currentConversationId;
          if (id) void flushQueuedPrompts(id);
        },
      );

      // Poll for due continues only while one is scheduled.
      watch(
        () => chatStore.hasScheduledUsageLimitWait,
        (scheduled) => {
          if (scheduled && !usageLimitTimer) {
            usageLimitTimer = setInterval(() => {
              for (const id of chatStore.dueUsageLimitWaits(Date.now())) {
                void continueAfterUsageLimit(id);
              }
            }, USAGE_LIMIT_CHECK_INTERVAL_MS);
          } else if (!scheduled && usageLimitTimer) {
            clearInterval(usageLimitTimer);
            usageLimitTimer = null;
          }
        },
        { immediate: true },
      );

      // Turning automatic continue off stops the continues already scheduled,
      // as it does in the CLI; each stays on offer in its conversation.
      watch(
        () => settingsStore.autoContinueAtUsageLimit,
        (enabled) => {
          if (!enabled) chatStore.unscheduleUsageLimitWaits();
        },
      );
    });

    // A turn stopped by a usage limit. Arrives just before that turn's done,
    // so the queue is already held when done decides whether to flush it:
    // a queued prompt sent now would only hit the same limit.
    cleanupUsageLimit = window.electron.claude.onUsageLimit((conversationId, stop) => {
      const wait = waitForStop(stop, settingsStore.autoContinueAtUsageLimit, Date.now());
      logger.info('Turn stopped by a usage limit', {
        conversationId,
        resetsAt: new Date(wait.resetsAt).toISOString(),
        limitType: wait.limitType,
        resumeAt: wait.resumeAt === null ? null : new Date(wait.resumeAt).toISOString(),
      });
      chatStore.setUsageLimitWait(conversationId, wait);
      chatStore.holdQueuedPrompts(conversationId);
    });

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

      // A queued prompt was written expecting the turn before it to have
      // worked, so it is held for the user rather than sent into a failed
      // state. Recorded on the conversation rather than passed to the flush,
      // because the queue is re-examined later from places that no longer know
      // this turn failed.
      chatStore.holdQueuedPrompts(conversationId);
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

      // A turn ending does NOT end the background tasks it started: they keep
      // running on the server, and their outcome arrives as task
      // notifications, or as the authoritative live set in
      // background_tasks_changed. Marking them finished here would show the
      // user work as done that is still going.

      // Save the conversation
      // If this is the current conversation, use normal save
      // If user switched away, we need to reconstruct and save
      if (conversationId === conversationsStore.currentConversationId) {
        // Current conversation - save normally
        const saved = await conversationsStore.saveCurrentConversation();
        // Release the buffer here too, or a later switch away would read a
        // stale snapshot from this finished turn — but ONLY once the turn is
        // actually on disk. A failed save retains the history in that same
        // buffer (see retainUnsavedMessages), and releasing it here would
        // throw away the only remaining copy a moment after keeping it.
        if (saved) chatStore.endMessageBuffer(conversationId);
      } else {
        // User switched away - need to save this conversation in background
        logger.info('Saving completed conversation in background', { conversationId });

        // Whatever this conversation is holding that is not on disk — a
        // background buffer, or a turn collected apart from a window that
        // falls short of the end of the conversation. Asking only for the
        // buffer meant writing nothing for a conversation holding the other,
        // which dropped the entire turn.
        const messages = chatStore.unwrittenMessagesFor(conversationId);

        let onDisk = true;
        if (messages && messages.length > 0) {
          // Clear any lingering streaming flag. The content itself is already
          // on each message — appendChunk writes into this buffer — so unlike
          // before there is nothing to copy across from the streaming state.
          const lastMsg = messages[messages.length - 1];
          if (lastMsg.role === 'assistant') {
            lastMsg.isStreaming = false;
          }

          onDisk = await conversationsStore.saveConversation(conversationId, messages);
        }

        // Same rule as the on-screen branch: a buffer that failed to reach
        // disk is the last copy of this turn, so it stays. Queued prompts are
        // flushed either way below — a failed save is not a reason to leave
        // the user's next message stuck in the queue.
        if (onDisk) chatStore.endMessageBuffer(conversationId);
      }

      // Anything the user wrote during the turn goes now — after the save, so
      // the finished turn is on disk before the next one starts changing it.
      await flushQueuedPrompts(conversationId);
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
      if (notification.status !== 'running') storeTaskOutcome(conversationId);
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
      if (chatStore.reconcileBackgroundTasks(conversationId, tasks)) storeTaskOutcome(conversationId);
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

    queueScope?.stop();
    queueScope = null;
    if (usageLimitTimer) {
      clearInterval(usageLimitTimer);
      usageLimitTimer = null;
    }
    if (cleanupUsageLimit) {
      cleanupUsageLimit();
      cleanupUsageLimit = null;
    }

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
    queuePrompt,
    releaseQueuedPrompts,
    approveAction,
    rejectAction,
    sendQuestionAnswer,
    abort,
    abortConversation,
    clearChat,
    revokeSessionPermission,
    continueUsageLimitNow,
    scheduleUsageLimitContinue,
    cancelUsageLimitContinue,
    dismissUsageLimit,

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
