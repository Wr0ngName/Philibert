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
