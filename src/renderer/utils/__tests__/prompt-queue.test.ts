/**
 * When a queued prompt is released.
 *
 * Every branch here is a case where getting it wrong is user-visible: a prompt
 * sent into the wrong conversation, two turns started at once, a prompt lost,
 * or a queue that sits there with nothing able to release it.
 */

import { describe, it, expect } from 'vitest';

import { nextFlush, type FlushConditions, type QueuedPrompt } from '../prompt-queue';

function prompt(id: string, content = `content of ${id}`): QueuedPrompt {
  return { id, content, queuedAt: 1 };
}

/** The ordinary case: a turn just finished in the conversation on screen. */
function conditions(overrides: Partial<FlushConditions> = {}): FlushConditions {
  return {
    conversationId: 'conv-1',
    currentConversationId: 'conv-1',
    queue: [prompt('q1'), prompt('q2')],
    isLoading: false,
    atResourceLimit: false,
    held: false,
    ...overrides,
  };
}

describe('nextFlush', () => {
  it('releases the oldest queued prompt', () => {
    // Order matters: these were written as a sequence of instructions.
    expect(nextFlush(conditions())).toEqual({ kind: 'send', prompt: prompt('q1') });
  });

  it('holds when nothing is queued', () => {
    expect(nextFlush(conditions({ queue: [] }))).toEqual({ kind: 'hold', reason: 'empty' });
  });

  it('holds a queue belonging to a conversation the user has left', () => {
    // Sending is only implemented for the conversation in view — the message
    // list, the streaming state and the save path all follow it — so this
    // would append to the wrong transcript.
    expect(nextFlush(conditions({ currentConversationId: 'conv-2' }))).toEqual({
      kind: 'hold',
      reason: 'not-current',
    });
  });

  it('holds while a turn is still running', () => {
    // Releasing here would start a second turn in the same conversation.
    expect(nextFlush(conditions({ isLoading: true }))).toEqual({
      kind: 'hold',
      reason: 'busy',
    });
  });

  it('holds when the queue is waiting on the user', () => {
    // They stopped a turn, or one failed. Either way the next prompt was
    // written expecting the previous turn to have run, so it waits for them.
    expect(nextFlush(conditions({ held: true }))).toEqual({
      kind: 'hold',
      reason: 'held',
    });
  });

  it('holds when the concurrent-run cap is reached', () => {
    // sendMessage would refuse this and write an error into the transcript.
    expect(nextFlush(conditions({ atResourceLimit: true }))).toEqual({
      kind: 'hold',
      reason: 'at-limit',
    });
  });

  it('reports being busy before reporting a hold', () => {
    // Both means a turn is running after the user stopped an earlier one.
    // Busy is the more specific reason and resolves by itself.
    expect(nextFlush(conditions({ isLoading: true, held: true }))).toEqual({
      kind: 'hold',
      reason: 'busy',
    });
  });

  it('holds an empty queue even when everything else would allow a send', () => {
    expect(nextFlush(conditions({ queue: [], atResourceLimit: true }))).toEqual({
      kind: 'hold',
      reason: 'empty',
    });
  });

  it('releases when a single prompt is queued', () => {
    expect(nextFlush(conditions({ queue: [prompt('only')] }))).toEqual({
      kind: 'send',
      prompt: prompt('only'),
    });
  });

  it('holds when there is no current conversation at all', () => {
    expect(nextFlush(conditions({ currentConversationId: null }))).toEqual({
      kind: 'hold',
      reason: 'not-current',
    });
  });

  it('does not mutate the queue it was given', () => {
    // The caller removes the prompt itself, deliberately before sending it, so
    // this must be a pure decision.
    const queue = [prompt('q1'), prompt('q2')];
    nextFlush(conditions({ queue }));
    expect(queue).toHaveLength(2);
  });
});
