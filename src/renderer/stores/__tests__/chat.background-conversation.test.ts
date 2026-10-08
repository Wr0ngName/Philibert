/**
 * Tool use in a conversation that runs while another one is on screen.
 *
 * `messages` only ever holds the conversation being viewed, and the whole
 * tool-use lifecycle used to begin with `if (conversationId !== current) return`.
 * So a conversation running in the background had nowhere to put anything: its
 * tool uses were dropped outright and the history came back with none in it at
 * all. Messages are now written to an on-screen list or a per-conversation
 * buffer, whichever applies.
 */

import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach } from 'vitest';

import type { PendingAction, ToolCaptureData } from '../../../shared/types';
import { useChatStore } from '../chat';

const RUNNING = 'conv-running';
const VIEWED = 'conv-viewed';

function capture(overrides: Partial<ToolCaptureData> = {}): ToolCaptureData {
  return {
    toolUseBlockId: 'toolu_1',
    toolName: 'Bash',
    description: 'ls -la',
    input: { command: 'ls -la' },
    ...overrides,
  } as ToolCaptureData;
}

function action(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    id: 'action-1',
    type: 'bash-command',
    toolName: 'Bash',
    description: 'ls -la',
    input: { command: 'ls -la' },
    status: 'pending',
    timestamp: Date.now(),
    ...overrides,
  } as PendingAction;
}

/**
 * Put the store in the reported state: a turn started on RUNNING, then the
 * user switched to VIEWED while it kept going.
 */
function startThenSwitchAway(store: ReturnType<typeof useChatStore>): void {
  store.setCurrentConversation(RUNNING);
  store.beginMessageBuffer(RUNNING);
  store.setCurrentConversation(VIEWED);
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('tool use while another conversation is viewed', () => {
  it('records an auto-approved tool use in the background conversation', () => {
    const store = useChatStore();
    startThenSwitchAway(store);

    store.addAutoToolUseMessage(RUNNING, capture());

    const buffered = store.getBufferedMessages(RUNNING) ?? [];
    const toolUses = buffered.filter(m => m.toolUse);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].toolUse?.toolName).toBe('Bash');
    expect(toolUses[0].toolUse?.toolUseBlockId).toBe('toolu_1');
  });

  it('keeps the viewed conversation untouched', () => {
    const store = useChatStore();
    startThenSwitchAway(store);

    store.addAutoToolUseMessage(RUNNING, capture());

    // Nothing from the background turn may leak into what is on screen.
    expect(store.messages.filter(m => m.toolUse)).toHaveLength(0);
  });

  it('carries the tool use through to its result rather than leaving it pending', () => {
    // Fixing only creation would show every background tool use stuck as
    // pending, since the update functions were gated the same way.
    const store = useChatStore();
    startThenSwitchAway(store);

    store.addAutoToolUseMessage(RUNNING, capture());
    store.updateToolUseResult(RUNNING, {
      toolUseBlockId: 'toolu_1',
      content: 'total 0',
      outputFile: '/tmp/out.txt',
    });

    const msg = (store.getBufferedMessages(RUNNING) ?? []).find(m => m.toolUse);
    expect(msg?.toolUse?.status).toBe('executed');
    expect(msg?.toolUse?.outputFile).toBe('/tmp/out.txt');
  });

  it('does not add a duplicate inline entry for a task its tool use already shows', () => {
    // handleTaskNotification skips the inline background-task entry when a
    // tool_use indicator already represents that task. That lookup was gated
    // on the active conversation too, so in the background it always missed
    // and produced a second entry for the same task.
    const store = useChatStore();
    startThenSwitchAway(store);

    store.addAutoToolUseMessage(RUNNING, capture({ toolUseBlockId: 'toolu_task' }));
    store.handleTaskNotification(RUNNING, {
      taskId: 'task-1',
      status: 'running',
      description: 'spawned agent',
      toolUseId: 'toolu_task',
    });

    const buffered = store.getBufferedMessages(RUNNING) ?? [];
    expect(buffered.filter(m => m.backgroundTask)).toHaveLength(0);
    expect(buffered.filter(m => m.toolUse)).toHaveLength(1);
  });

  it('still adds an inline entry for a task with no tool use behind it', () => {
    // A plain backgrounded command has no tool_use indicator, so it does need
    // its own inline entry — the dedupe must not swallow it.
    const store = useChatStore();
    startThenSwitchAway(store);

    store.handleTaskNotification(RUNNING, {
      taskId: 'task-2',
      status: 'running',
      description: 'long running command',
    });

    const buffered = store.getBufferedMessages(RUNNING) ?? [];
    expect(buffered.filter(m => m.backgroundTask)).toHaveLength(1);
  });

  it('clears tool-use spinners when the background turn finishes', () => {
    const store = useChatStore();
    startThenSwitchAway(store);

    store.addToolUseMessage(RUNNING, action());
    store.completeToolUseMessages(RUNNING);

    const msg = (store.getBufferedMessages(RUNNING) ?? []).find(m => m.toolUse);
    expect(msg?.toolUse?.status).toBe('executed');
  });

  it('keeps text that preceded a tool call', () => {
    // splitStreamingForTool reset the streaming state, and only the final
    // segment was copied onto a message at save time, so text before a tool
    // call was lost for a background conversation.
    const store = useChatStore();
    startThenSwitchAway(store);

    store.appendChunk(RUNNING, 'Let me look at that.');
    store.addAutoToolUseMessage(RUNNING, capture());
    store.appendChunk(RUNNING, 'Here is what I found.');

    const buffered = store.getBufferedMessages(RUNNING) ?? [];
    const text = buffered.filter(m => !m.toolUse && m.content).map(m => m.content);
    expect(text).toContain('Let me look at that.');
    expect(text).toContain('Here is what I found.');
  });

  it('orders the tool use between the text segments', () => {
    const store = useChatStore();
    startThenSwitchAway(store);

    store.appendChunk(RUNNING, 'before');
    store.addAutoToolUseMessage(RUNNING, capture());
    store.appendChunk(RUNNING, 'after');

    const buffered = store.getBufferedMessages(RUNNING) ?? [];
    const shape = buffered
      .filter(m => m.toolUse || m.content)
      .map(m => (m.toolUse ? 'tool' : m.content));
    expect(shape).toEqual(['before', 'tool', 'after']);
  });

  it('ignores a conversation that is neither viewed nor running', () => {
    // Null sink means "nothing to update", which must not throw or invent
    // state for an unknown conversation.
    const store = useChatStore();
    store.setCurrentConversation(VIEWED);

    expect(() => store.addAutoToolUseMessage('conv-unknown', capture())).not.toThrow();
    expect(store.getBufferedMessages('conv-unknown')).toBeNull();
  });

  it('surfaces buffered tool uses once the conversation is viewed again', () => {
    // The task detail modal resolves a task's spawning tool out of the
    // on-screen message list. Tool uses recorded while the conversation ran
    // off screen therefore have to reach that list when the user comes back,
    // or the modal has nothing to show for them. Switching back clones the
    // buffer into the visible messages (see conversations.ts), and this pins
    // that the buffer holds what that clone needs.
    const store = useChatStore();
    startThenSwitchAway(store);

    store.addAutoToolUseMessage(RUNNING, capture({ toolUseBlockId: 'toolu_bg' }));

    const buffered = store.getBufferedMessages(RUNNING) ?? [];
    store.setCurrentConversation(RUNNING);
    store.loadMessages(buffered);

    const found = store.messages.find(m => m.toolUse?.toolUseBlockId === 'toolu_bg');
    expect(found?.toolUse?.toolName).toBe('Bash');
    expect(found?.toolUse?.input).toEqual({ command: 'ls -la' });
  });

  it('stops buffering once released', () => {
    const store = useChatStore();
    startThenSwitchAway(store);
    store.addAutoToolUseMessage(RUNNING, capture());

    store.endMessageBuffer(RUNNING);

    expect(store.getBufferedMessages(RUNNING)).toBeNull();
    // And further updates have nowhere to go rather than resurrecting it.
    store.addAutoToolUseMessage(RUNNING, capture({ toolUseBlockId: 'toolu_2' }));
    expect(store.getBufferedMessages(RUNNING)).toBeNull();
  });
});
