/**
 * Reconciling background tasks against the SDK's authoritative live set.
 *
 * Task status only ever moved on an incremental notification, and nothing in
 * the app revisited it afterwards — `clearAllBackgroundTasks` existed but had
 * no call sites. So any missed or mis-keyed completion left a task 'running'
 * forever, which is how a finished task came to sit in the panel with a
 * duration measured in hours.
 *
 * The SDK pushes `background_tasks_changed` with REPLACE semantics precisely
 * to close that hole. These tests pin both halves: that a vanished task is
 * retired, and — the regression risk — that a live task tracked under a stale
 * key is adopted rather than wrongly retired.
 */

import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach } from 'vitest';

import type { LiveBackgroundTask } from '../../../shared/types';
import { useChatStore } from '../chat';

const CONV = 'conv-1';

function live(taskId: string, description: string, ambient = false): LiveBackgroundTask {
  return { taskId, taskType: 'shell', description, ambient };
}

/** Seed a running task, going through the store's own notification path. */
function seedRunning(store: ReturnType<typeof useChatStore>, taskId: string, description: string): void {
  store.handleTaskNotification(CONV, { taskId, status: 'running', description });
}

function taskMap(store: ReturnType<typeof useChatStore>) {
  return store.getConversationState(CONV).backgroundTasks;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('reconcileBackgroundTasks', () => {
  it('retires a running task the SDK no longer lists', () => {
    const store = useChatStore();
    seedRunning(store, 'task-1', 'Install Unity editor via Hub CLI');
    expect(taskMap(store).get('task-1')?.status).toBe('running');

    store.reconcileBackgroundTasks(CONV, []);

    const task = taskMap(store).get('task-1');
    expect(task?.status).toBe('stopped');
    expect(task?.completedAt).toBeTypeOf('number');
  });

  it('marks a vanished task stopped rather than completed', () => {
    // The live list says only that the task is gone, not that it succeeded.
    // Claiming success would invent an outcome we were never told.
    const store = useChatStore();
    seedRunning(store, 'task-1', 'something');
    store.reconcileBackgroundTasks(CONV, []);
    expect(taskMap(store).get('task-1')?.status).not.toBe('completed');
  });

  it('leaves a still-live task running', () => {
    const store = useChatStore();
    seedRunning(store, 'task-1', 'long build');

    store.reconcileBackgroundTasks(CONV, [live('task-1', 'long build')]);

    expect(taskMap(store).get('task-1')?.status).toBe('running');
    expect(taskMap(store).get('task-1')?.completedAt).toBeUndefined();
  });

  it('adopts a live task tracked under a stale key instead of retiring it', () => {
    // The entry is first keyed by the tool_use id; the live list uses the SDK
    // task id. Without adoption this task would be retired as vanished while
    // still running — the regression this reconciliation could introduce.
    const store = useChatStore();
    seedRunning(store, 'toolu_abc', 'npm run build');

    store.reconcileBackgroundTasks(CONV, [live('task-99', 'npm run build')]);

    const map = taskMap(store);
    expect(map.has('toolu_abc')).toBe(false);
    expect(map.get('task-99')?.status).toBe('running');
    expect(map.get('task-99')?.id).toBe('task-99');
  });

  it('does not adopt across different descriptions', () => {
    const store = useChatStore();
    seedRunning(store, 'toolu_abc', 'npm run build');

    store.reconcileBackgroundTasks(CONV, [live('task-99', 'a completely different task')]);

    // The tracked task matched nothing live, so it ended.
    expect(taskMap(store).get('toolu_abc')?.status).toBe('stopped');
  });

  it('counts ambient tasks as live so they are never retired', () => {
    // Watchers are live but excluded from activity indicators; being absent
    // from the visible set must not mean "ended".
    const store = useChatStore();
    seedRunning(store, 'task-watch', 'watching deploy');

    store.reconcileBackgroundTasks(CONV, [live('task-watch', 'watching deploy', true)]);

    expect(taskMap(store).get('task-watch')?.status).toBe('running');
  });

  it('leaves already-finished tasks untouched', () => {
    const store = useChatStore();
    seedRunning(store, 'task-1', 'done thing');
    store.handleTaskNotification(CONV, { taskId: 'task-1', status: 'completed', summary: 'all good' });
    const before = taskMap(store).get('task-1');

    store.reconcileBackgroundTasks(CONV, []);

    const after = taskMap(store).get('task-1');
    expect(after?.status).toBe('completed');
    expect(after?.summary).toBe('all good');
    expect(after?.completedAt).toBe(before?.completedAt);
  });

  it('retires only tasks of the conversation being reconciled', () => {
    const store = useChatStore();
    seedRunning(store, 'task-1', 'in conv 1');
    store.handleTaskNotification('conv-2', { taskId: 'task-2', status: 'running', description: 'in conv 2' });

    store.reconcileBackgroundTasks(CONV, []);

    expect(taskMap(store).get('task-1')?.status).toBe('stopped');
    expect(store.getConversationState('conv-2').backgroundTasks.get('task-2')?.status).toBe('running');
  });

  it('does nothing for a conversation with no state', () => {
    const store = useChatStore();
    expect(() => store.reconcileBackgroundTasks('never-seen', [])).not.toThrow();
  });

  it('retires several stale tasks in one pass', () => {
    const store = useChatStore();
    seedRunning(store, 'task-1', 'one');
    seedRunning(store, 'task-2', 'two');
    seedRunning(store, 'task-3', 'three');

    store.reconcileBackgroundTasks(CONV, [live('task-2', 'two')]);

    expect(taskMap(store).get('task-1')?.status).toBe('stopped');
    expect(taskMap(store).get('task-2')?.status).toBe('running');
    expect(taskMap(store).get('task-3')?.status).toBe('stopped');
  });
});

/**
 * `completedAt` is what a duration is measured to, so a task that is running
 * must not have one. Reported as the runtime timer sometimes not
 * incrementing: a task that reported a terminal status and then went on
 * reporting progress kept the stamp from that moment, and sat in the panel
 * listed as running with its duration frozen there.
 */
describe('completedAt tracks the status in both directions', () => {
  it('is not set while a task is running', () => {
    const store = useChatStore();
    seedRunning(store, 'task-1', 'one');

    expect(taskMap(store).get('task-1')?.completedAt).toBeUndefined();
  });

  it('is set when a task finishes', () => {
    const store = useChatStore();
    seedRunning(store, 'task-1', 'one');

    store.handleTaskNotification(CONV, { taskId: 'task-1', status: 'completed', summary: 'done' });

    expect(taskMap(store).get('task-1')?.completedAt).toBeTypeOf('number');
  });

  it('is cleared again when the task turns out to still be running', () => {
    // A misattributed completion — the single-running fallback can still
    // produce one — followed by the task's own progress.
    const store = useChatStore();
    seedRunning(store, 'task-1', 'one');
    store.handleTaskNotification(CONV, { taskId: 'task-1', status: 'completed', summary: 'done' });
    expect(taskMap(store).get('task-1')?.completedAt).toBeTypeOf('number');

    store.handleTaskNotification(CONV, { taskId: 'task-1', status: 'running', description: 'one' });

    const task = taskMap(store).get('task-1');
    expect(task?.status).toBe('running');
    expect(task?.completedAt).toBeUndefined();
  });

  it('keeps the first completion stamp when a terminal status repeats', () => {
    const store = useChatStore();
    seedRunning(store, 'task-1', 'one');
    store.handleTaskNotification(CONV, { taskId: 'task-1', status: 'completed', summary: 'done' });
    const first = taskMap(store).get('task-1')?.completedAt;

    store.handleTaskNotification(CONV, { taskId: 'task-1', status: 'completed', summary: 'done again' });

    // Re-stamping is acceptable; losing it is not. The duration must still be
    // measured to a completion, not to the live clock.
    expect(taskMap(store).get('task-1')?.completedAt).toBeTypeOf('number');
    expect(taskMap(store).get('task-1')?.completedAt).toBeGreaterThanOrEqual(first as number);
  });

  it('does not carry a completion stamp across a re-key', () => {
    // Adoption re-keys a task from its tool_use id to the SDK's task id.
    const store = useChatStore();
    seedRunning(store, 'toolu_abc', 'one');
    store.handleTaskNotification(CONV, { taskId: 'toolu_abc', status: 'completed', summary: 'done' });

    store.handleTaskNotification(CONV, { taskId: 'task-real', status: 'running', description: 'one' });

    expect(taskMap(store).get('task-real')?.completedAt).toBeUndefined();
  });
});

/**
 * Restoring the model's task list.
 *
 * Covered end to end through a real restart in the persistence round-trip
 * suite; these pin the store's own rules, which that test cannot show: that a
 * restore is exact, and that it never overwrites a list that is already live.
 */
describe('restoreTaskList', () => {
  const items = [
    {
      id: 'task_a',
      subject: 'Write the parser',
      description: 'tokenise, then build the tree',
      activeForm: 'Writing the parser',
      status: 'completed' as const,
      updatedAt: 1_700_000_000_000,
    },
    { id: 'task_b', subject: 'Cover it with tests', status: 'in_progress' as const, updatedAt: 1_700_000_000_001 },
    { id: 'task_c', subject: 'Wire up the CLI', status: 'pending' as const, updatedAt: 1_700_000_000_002 },
  ];

  it('restores every field verbatim, in order', () => {
    const store = useChatStore();
    store.setCurrentConversation(CONV);

    expect(store.restoreTaskList(CONV, items)).toBe(true);

    expect(store.taskListItems).toEqual(items);
  });

  it('keeps deleted items, which are how a later update resolves', () => {
    const store = useChatStore();
    store.setCurrentConversation(CONV);
    const withDeleted = [
      ...items,
      { id: 'task_d', subject: 'Abandoned', status: 'deleted' as const, updatedAt: 1_700_000_000_003 },
    ];

    store.restoreTaskList(CONV, withDeleted);

    // Hidden from the panel…
    expect(store.taskListItems.map((t) => t.id)).toEqual(['task_a', 'task_b', 'task_c']);
    // …but still there to be updated.
    expect(store.getTaskListItems(CONV).map((t) => t.id)).toContain('task_d');
  });

  it('does not overwrite a list that is already live', () => {
    // A turn collecting in the background is ahead of anything on disk.
    const store = useChatStore();
    store.setCurrentConversation(CONV);
    store.restoreTaskList(CONV, [items[0]]);

    expect(store.restoreTaskList(CONV, items)).toBe(true);

    expect(store.getTaskListItems(CONV)).toEqual([items[0]]);
  });

  it('reports that there was nothing saved to restore', () => {
    // What makes the caller fall back to replaying the transcript.
    const store = useChatStore();
    expect(store.restoreTaskList(CONV, undefined)).toBe(false);
    expect(store.restoreTaskList(CONV, [])).toBe(false);
  });

  it('ignores an entry with no id rather than keying it on undefined', () => {
    const store = useChatStore();
    store.setCurrentConversation(CONV);

    store.restoreTaskList(CONV, [
      items[0],
      { subject: 'no id', status: 'pending', updatedAt: 1 } as never,
    ]);

    expect(store.getTaskListItems(CONV)).toEqual([items[0]]);
  });

  it('keeps one conversation out of another', () => {
    const store = useChatStore();
    store.setCurrentConversation(CONV);
    store.restoreTaskList(CONV, items);
    store.restoreTaskList('conv-2', [items[2]]);

    expect(store.getTaskListItems(CONV)).toHaveLength(3);
    expect(store.getTaskListItems('conv-2')).toEqual([items[2]]);
  });
});

describe('rebuildTaskList', () => {
  /** A persisted tool-use message for a Task* call. */
  function taskMessage(
    blockId: string,
    toolName: string,
    input: Record<string, unknown>,
    taskListId?: string,
  ) {
    return {
      id: `msg-${blockId}`,
      role: 'assistant' as const,
      content: '',
      timestamp: 1_700_000_000_000,
      toolUse: {
        actionId: blockId,
        toolName,
        description: toolName,
        status: 'executed' as const,
        toolUseBlockId: blockId,
        input,
        ...(taskListId ? { taskListId } : {}),
      },
    };
  }

  it('replays creates and the updates that match them', () => {
    const store = useChatStore();
    store.setCurrentConversation(CONV);

    store.rebuildTaskList(CONV, [
      taskMessage('toolu_1', 'TaskCreate', { subject: 'one' }, 'task_1'),
      taskMessage('toolu_2', 'TaskCreate', { subject: 'two' }, 'task_2'),
      taskMessage('toolu_3', 'TaskUpdate', { taskId: 'task_1', status: 'completed' }),
    ]);

    expect(store.getTaskListItems(CONV).map((t) => [t.id, t.subject, t.status])).toEqual([
      ['task_1', 'one', 'completed'],
      ['task_2', 'two', 'pending'],
    ]);
  });

  it('skips an update whose task was never recorded with its id', () => {
    // Older history: the create carries no taskListId, so nothing links the
    // two. The task keeps the status its create gave it.
    const store = useChatStore();
    store.setCurrentConversation(CONV);

    store.rebuildTaskList(CONV, [
      taskMessage('toolu_1', 'TaskCreate', { subject: 'one' }),
      taskMessage('toolu_2', 'TaskUpdate', { taskId: 'task_1', status: 'completed' }),
    ]);

    expect(store.getTaskListItems(CONV).map((t) => [t.subject, t.status])).toEqual([
      ['one', 'pending'],
    ]);
  });

  it('ignores every other tool', () => {
    const store = useChatStore();
    store.setCurrentConversation(CONV);

    store.rebuildTaskList(CONV, [
      taskMessage('toolu_1', 'Bash', { command: 'ls' }),
      taskMessage('toolu_2', 'Read', { file_path: '/tmp/x' }),
    ]);

    expect(store.getTaskListItems(CONV)).toEqual([]);
  });

  it('does not overwrite a list that is already live', () => {
    const store = useChatStore();
    store.setCurrentConversation(CONV);
    store.restoreTaskList(CONV, [
      { id: 'task_live', subject: 'live', status: 'in_progress', updatedAt: 1 },
    ]);

    store.rebuildTaskList(CONV, [taskMessage('toolu_1', 'TaskCreate', { subject: 'one' }, 'task_1')]);

    expect(store.getTaskListItems(CONV).map((t) => t.id)).toEqual(['task_live']);
  });
});
