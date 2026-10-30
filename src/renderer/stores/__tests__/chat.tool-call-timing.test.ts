/**
 * When a tool call ran, as Tool Details measures it: from when Claude made
 * the call — or from the approval, for one that waited on it — to the first
 * word that it finished.
 */

import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { ToolCaptureData } from '../../../shared/types';
import { useChatStore } from '../chat';

const CONV = 'conv-1';
const T0 = 1_700_000_000_000;

function capture(): ToolCaptureData {
  return { toolUseBlockId: 'toolu_1', toolName: 'Bash', description: 'Run: npm test', input: { command: 'npm test' } };
}

function call(store: ReturnType<typeof useChatStore>) {
  const message = store.messages.find((m) => m.toolUse?.toolUseBlockId === 'toolu_1');
  if (!message?.toolUse) throw new Error('no call');
  return { message, toolUse: message.toolUse };
}

beforeEach(() => {
  setActivePinia(createPinia());
  useChatStore().setCurrentConversation(CONV);
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('tool call timing', () => {
  it('ends when the result comes back', () => {
    const store = useChatStore();
    store.addAutoToolUseMessage(CONV, capture());
    vi.setSystemTime(T0 + 12_000);
    store.updateToolUseResult(CONV, { toolUseBlockId: 'toolu_1', outputFile: '', content: 'ok' });

    const { message, toolUse } = call(store);
    expect(message.timestamp).toBe(T0);
    expect(toolUse.startedAt).toBeUndefined();
    expect(toolUse.completedAt).toBe(T0 + 12_000);
  });

  it('keeps the first end it was told of', () => {
    const store = useChatStore();
    store.addAutoToolUseMessage(CONV, capture());
    vi.setSystemTime(T0 + 5_000);
    store.updateToolUseStatus(CONV, 'toolu_1', 'executed');
    vi.setSystemTime(T0 + 9_000);
    store.updateToolUseResult(CONV, { toolUseBlockId: 'toolu_1', outputFile: '', content: 'ok' });

    expect(call(store).toolUse.completedAt).toBe(T0 + 5_000);
  });

  it('starts at the approval for a call that waited on it', () => {
    const store = useChatStore();
    store.addAutoToolUseMessage(CONV, capture());
    vi.setSystemTime(T0 + 30_000);
    store.updateToolUseStatus(CONV, 'toolu_1', 'approved');

    expect(call(store).toolUse.startedAt).toBe(T0 + 30_000);
  });
});
