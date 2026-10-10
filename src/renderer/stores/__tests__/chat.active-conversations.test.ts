/**
 * Whose activity indicator is showing.
 *
 * The reported bug, with two conversations running at once: one kept its
 * spinner after it had finished, the other lost its spinner while still
 * running. The cause was not a routing mistake — the done and error handlers
 * are correctly keyed by conversation — but that nothing reconciled the
 * renderer's per-conversation `isLoading` against the main process.
 *
 * `isLoading` is set optimistically on send and cleared by CLAUDE_DONE, so any
 * done that is missed, duplicated, or attributed to a different turn left the
 * flag wrong for the rest of the session. The main process already knew the
 * truth (`processingSessions`, emitted on every change) but sent only counts.
 *
 * These pin the reconciliation, in both directions.
 */

import { setActivePinia, createPinia } from 'pinia';
import { describe, it, expect, beforeEach } from 'vitest';

import { useChatStore } from '../chat';

const A = 'conv-a';
const B = 'conv-b';

describe('reconcileActiveConversations', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('clears a conversation the main process is no longer running', () => {
    // Symptom one: the spinner outliving the turn. A missed done leaves
    // isLoading true, and nothing else ever clears it.
    const store = useChatStore();
    store.setLoading(A, true);

    store.reconcileActiveConversations([]);

    expect(store.isConversationLoading(A)).toBe(false);
  });

  it('restores a conversation that is running but was marked idle', () => {
    // Symptom two: losing the spinner while the turn is still going, because
    // something cleared the flag early.
    const store = useChatStore();
    store.setLoading(A, true);
    store.setLoading(A, false); // a done that should not have applied

    store.reconcileActiveConversations([A]);

    expect(store.isConversationLoading(A)).toBe(true);
  });

  it('keeps one conversation running while clearing the other', () => {
    // The reported combination, in one step.
    const store = useChatStore();
    store.setLoading(A, true);
    store.setLoading(B, true);

    store.reconcileActiveConversations([B]);

    expect(store.isConversationLoading(A)).toBe(false);
    expect(store.isConversationLoading(B)).toBe(true);
  });

  it('tracks a conversation that has never been opened', () => {
    // A conversation can be mid-turn without the renderer holding any state
    // for it, and the indicator reads that state — so it has to be created.
    const store = useChatStore();

    store.reconcileActiveConversations([A]);

    expect(store.isConversationLoading(A)).toBe(true);
  });

  it('exposes the authoritative set', () => {
    const store = useChatStore();

    store.reconcileActiveConversations([A, B]);

    expect(store.activeConversationIds).toEqual([A, B]);
  });

  it('leaves an idle conversation idle', () => {
    const store = useChatStore();
    store.setLoading(A, false);

    store.reconcileActiveConversations([]);

    expect(store.isConversationLoading(A)).toBe(false);
  });

  it('is idempotent', () => {
    const store = useChatStore();

    store.reconcileActiveConversations([A]);
    store.reconcileActiveConversations([A]);

    expect(store.isConversationLoading(A)).toBe(true);
    expect(store.activeConversationIds).toEqual([A]);
  });

  it('does not disturb messages when correcting a flag', () => {
    // Reconciliation is about the indicator only. Finishing streaming or
    // touching the transcript here would mean a transient disagreement
    // rewrote the conversation.
    const store = useChatStore();
    store.setCurrentConversation(A);
    store.addUserMessage('hello');
    store.setLoading(A, true);

    store.reconcileActiveConversations([]);

    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].content).toBe('hello');
  });
});
