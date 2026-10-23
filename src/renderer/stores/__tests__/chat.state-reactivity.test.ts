/**
 * Per-conversation state is created lazily, often during a render.
 *
 * The creating call used to return the plain object it had just put in the
 * Map, while every later call got the Map's reactive proxy. An effect (a
 * component render, a watchEffect) that happened to create the state tracked
 * the untracked object and was never re-run — the permissions badge stayed at
 * 0 after a session grant arrived. A plain read recovers on its own, which is
 * why this has to go through an effect.
 */

import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach } from 'vitest';
import { nextTick, watchEffect } from 'vue';

import type { SessionPermissionEntry } from '../../../shared/types';
import { useChatStore } from '../chat';

const GRANT: SessionPermissionEntry = {
  id: 'perm-1', toolName: 'WebSearch', description: 'Allow WebSearch for this session', grantedAt: 0,
};

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('lazily created conversation state', () => {
  it('stays reactive for the effect that created it', async () => {
    const store = useChatStore();
    store.setCurrentConversation('conv-1');

    // The effect's first run is what creates the conversation state.
    let count = -1;
    const stop = watchEffect(() => {
      count = store.sessionPermissionCount;
    });
    expect(count).toBe(0);

    store.updateSessionPermissions('conv-1', [GRANT]);
    await nextTick();

    expect(count).toBe(1);
    stop();
  });
});
