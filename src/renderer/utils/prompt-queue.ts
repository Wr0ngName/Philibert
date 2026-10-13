/**
 * Prompts the user wrote while a turn was still running.
 *
 * Until now the input offered no way to do that: while a query was in flight
 * the Send button was replaced by Stop, and Enter did nothing. The only way to
 * say the next thing was to abort the turn, which kills the run and every
 * agent in it. Queueing keeps the thought without costing the work.
 *
 * One prompt is released at a time, when the turn it was waiting on finishes.
 * The decision of whether to release one is kept here, as a pure function,
 * because it is the part with rules in it — and because the composable that
 * owns the IPC listeners is not reachable from a test.
 */

/** A prompt waiting for the current turn to finish. */
export interface QueuedPrompt {
  /** Stable id, so the UI can list and remove individual entries. */
  id: string;
  content: string;
  queuedAt: number;
}

/** What the caller knows at the moment a turn ends. */
export interface FlushConditions {
  /** The conversation whose turn just ended. */
  conversationId: string;
  /** The conversation the user is looking at. */
  currentConversationId: string | null;
  /** Prompts waiting on this conversation, oldest first. */
  queue: readonly QueuedPrompt[];
  /** Whether this conversation has a query in flight. */
  isLoading: boolean;
  /** Whether the concurrent-run cap is already reached. */
  atResourceLimit: boolean;
  /**
   * Whether the queue is waiting on the user rather than on a turn — they
   * stopped one, or one failed.
   */
  held: boolean;
}

/** Why a queued prompt was not released. */
export type HoldReason =
  | 'empty'
  | 'not-current'
  | 'busy'
  | 'at-limit'
  | 'held';

export type FlushDecision =
  | { kind: 'send'; prompt: QueuedPrompt }
  | { kind: 'hold'; reason: HoldReason };

/**
 * Whether to release the next queued prompt, and which one.
 *
 * Holds, rather than sends, in five cases:
 *
 *  - nothing queued;
 *  - the conversation is not the one on screen. Sending is only implemented
 *    for the conversation in view — the message list, the streaming state and
 *    the save path all follow `currentConversationId` — so a queue belonging
 *    to a conversation the user has left waits until they come back to it
 *    rather than being sent into the wrong transcript;
 *  - a turn is already running, so releasing one would start a second;
 *  - the concurrent-run cap is reached, which `sendMessage` would refuse with
 *    an error written into the transcript. Better to keep holding and release
 *    when room appears;
 *  - the queue is held for the user: they stopped a turn, or one failed.
 *
 * Every one of these except the last clears on its own, because the caller
 * re-asks whenever the conditions change rather than only when a turn ends.
 * That matters: a turn ending is the only event the first version waited for,
 * so a queue held for any other reason — the user had switched away, the run
 * cap was full — stayed held forever, with no event left to release it.
 */
export function nextFlush(conditions: FlushConditions): FlushDecision {
  const { queue, conversationId, currentConversationId, isLoading } = conditions;

  if (queue.length === 0) return { kind: 'hold', reason: 'empty' };
  if (conversationId !== currentConversationId) {
    return { kind: 'hold', reason: 'not-current' };
  }
  if (isLoading) return { kind: 'hold', reason: 'busy' };
  if (conditions.held) return { kind: 'hold', reason: 'held' };
  if (conditions.atResourceLimit) return { kind: 'hold', reason: 'at-limit' };

  return { kind: 'send', prompt: queue[0] };
}
