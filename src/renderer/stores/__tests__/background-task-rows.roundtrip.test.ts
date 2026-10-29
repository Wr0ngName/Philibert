/**
 * The task rows in the discussion, through the real path.
 *
 * Reported as: a background task's row stays "Running" in the discussion
 * forever, long after the task is done and gone from the background tasks
 * list — and clicking it does not open the task's details the way clicking it
 * in that list does.
 *
 * Real ChatWindow, real stores, real preload, real conversation IPC handlers
 * and the real ConversationService; only Electron and the filesystem are
 * faked. Task events arrive the way the main process delivers them.
 */

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { LiveBackgroundTask, TaskNotification } from '@shared/types';

vi.mock('node:fs', async () => (await import('./support/real-stack')).fakeFsModule());
vi.mock('electron', async () => (await import('./support/real-stack')).fakeElectronModule());
vi.mock('../../../main/utils/paths', () => ({
  getConversationsPath: () => '/conversations',
  isPathWithin: (target: string, root: string) => target.startsWith(root),
}));
vi.mock('../../../main/utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogLevel: vi.fn(),
}));
vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { setupConversationIPC } from '../../../main/ipc/conversations';
import { ConversationService } from '../../../main/services/ConversationService';
import '../../../preload/preload';
import ChatWindow from '../../components/chat/ChatWindow.vue';
import { useChatStore } from '../chat';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import {
  startRealStack, settle, onDisk, disk, emitIpc, mainHandlers, mountApp, unmountApp, send,
} from './support/real-stack';

function notify(conversationId: string, notification: TaskNotification): void {
  emitIpc('claude:task-notification', conversationId, notification);
}

function liveSet(conversationId: string, tasks: Partial<LiveBackgroundTask>[]): void {
  emitIpc('claude:background-tasks-changed', conversationId, tasks.map((t) => ({
    taskType: 'shell', description: '', ambient: false, ...t,
  })));
}

describe('task rows in the discussion', () => {
  let store: ReturnType<typeof useConversationsStore>;
  let chat: ReturnType<typeof useChatStore>;
  let app: ReturnType<typeof mount>;

  async function startApp(): Promise<void> {
    store = useConversationsStore();
    chat = useChatStore();
    const settings = useSettingsStore();
    settings.config.workingDirectory = '/home/user/project';
    settings.config.apiKey = 'test-key';
    await store.loadConversationList();
    await settle();
    app = mountApp(ChatWindow);
    await settle();
  }

  /** The text of the one task row on screen. */
  function row(): string {
    const rows = app.findAll('.task-entry');
    expect(rows, 'expected exactly one task row in the discussion').toHaveLength(1);
    return rows[0].text();
  }

  /** The open task detail modal's text, or null when none is open. */
  function detail(): string | null {
    const modal = [...document.body.querySelectorAll('[role="dialog"]')]
      .find((d) => d.textContent?.includes('Task Details'));
    return modal?.textContent ?? null;
  }

  /** A conversation whose turn started a background command, turn over. */
  async function conversationWithATask(): Promise<string> {
    store.createNewConversation();
    const id = store.currentConversationId!;
    await send(app, 'run the build in the background');
    notify(id, { taskId: 'tool-1', status: 'running', description: 'npm run build' });
    emitIpc('claude:chunk', id, 'started it');
    emitIpc('claude:done', id);
    await settle(20);
    expect(row()).toContain('Running');
    return id;
  }

  beforeEach(async () => {
    await startRealStack({
      ConversationService: ConversationService as unknown as new () => never,
      setupConversationIPC: setupConversationIPC as unknown as (service: never) => void,
    });
    mainHandlers.set('claude:send', () => undefined);
    await startApp();
  });

  afterEach(() => {
    unmountApp();
    document.body.innerHTML = '';
  });

  it('shows the outcome once the task completes', async () => {
    const id = await conversationWithATask();

    notify(id, { taskId: 'tool-1', status: 'completed', summary: 'built' });
    await settle();

    expect(row()).toContain('Done');
  });

  it('stops showing Running when the task leaves the live set without a notification', async () => {
    // The completion notification was missed; the live set is what retires
    // the task. The list dropped it, the row went on saying Running.
    const id = await conversationWithATask();
    liveSet(id, [{ taskId: 'tool-1', description: 'npm run build' }]);
    await settle();

    liveSet(id, []);
    await settle();

    expect(chat.runningBackgroundTasksList).toHaveLength(0);
    expect(row()).not.toContain('Running');
  });

  it('follows the task after it is re-keyed by the live set', async () => {
    // The live set names the task by the SDK's id while the row holds the
    // tool_use id it started under. The completion then arrives for the new
    // id only.
    const id = await conversationWithATask();
    liveSet(id, [{ taskId: 'sdk-1', description: 'npm run build' }]);
    await settle();

    notify(id, { taskId: 'sdk-1', status: 'completed', summary: 'built' });
    await settle();

    expect(row()).toContain('Done');
  });

  it('opens the details when the row is clicked', async () => {
    await conversationWithATask();

    await app.find('.task-entry').trigger('click');
    await settle();

    expect(detail()).toContain('npm run build');
  });

  it('opens the details of a re-keyed task when its row is clicked', async () => {
    const id = await conversationWithATask();
    liveSet(id, [{ taskId: 'sdk-1', description: 'npm run build' }]);
    await settle();

    await app.find('.task-entry').trigger('click');
    await settle();

    expect(detail()).toContain('npm run build');
  });

  it('shows the outcome of a task that ended while another conversation was open', async () => {
    const id = await conversationWithATask();
    store.createNewConversation();
    await send(app, 'something else meanwhile');
    await settle(20);

    notify(id, { taskId: 'tool-1', status: 'completed', summary: 'built' });
    await settle();
    await store.switchConversation(id);
    await settle(20);

    expect(row()).toContain('Done');
  });

  it('stores the outcome, so it is still there after a restart', async () => {
    const id = await conversationWithATask();
    notify(id, { taskId: 'tool-1', status: 'completed', summary: 'built' });
    await settle(20);

    expect(onDisk(id)?.messages.find((m) => m.backgroundTask)?.backgroundTask?.status)
      .toBe('completed');
  });

  it('stores the end of a task the live set retired', async () => {
    const id = await conversationWithATask();
    liveSet(id, [{ taskId: 'tool-1', description: 'npm run build' }]);
    await settle();

    liveSet(id, []);
    await settle(20);

    expect(onDisk(id)?.messages.find((m) => m.backgroundTask)?.backgroundTask?.status)
      .toBe('stopped');
  });

  it('writes nothing for an outcome in a conversation that is not open', async () => {
    const id = await conversationWithATask();
    store.createNewConversation();
    await send(app, 'something else meanwhile');
    await settle(20);
    const writes = disk.writes;

    notify(id, { taskId: 'tool-1', status: 'completed', summary: 'built' });
    await settle(20);

    expect(disk.writes).toBe(writes);
  });

  it('shows a stored outcome after a restart, with its duration', async () => {
    const id = await conversationWithATask();
    notify(id, { taskId: 'tool-1', status: 'completed', summary: 'built' });
    await settle(20);
    unmountApp();
    setActivePinia(createPinia());
    await startApp();
    await store.switchConversation(id);
    await settle(20);

    expect(row()).toContain('Done');
    await app.find('.task-entry').trigger('click');
    await settle();
    expect(detail()).toContain('built');
    expect(detail()).toContain('Duration:');
  });

  it('gives no duration for a task whose end was never recorded', async () => {
    // Measured up to now, it would read as having run since it started.
    const id = await conversationWithATask();
    unmountApp();
    setActivePinia(createPinia());
    await startApp();
    await store.switchConversation(id);
    await settle(20);

    await app.find('.task-entry').trigger('click');
    await settle();
    expect(detail()).not.toContain('Duration:');
  });

  it('does not show a task from before a restart as running, and still opens it', async () => {
    // The app quit with the task's row stored as running: nothing is running
    // it any more, and nothing will ever report on it again.
    const id = await conversationWithATask();
    unmountApp();
    setActivePinia(createPinia());
    await startApp();
    await store.switchConversation(id);
    await settle(20);

    expect(row()).not.toContain('Running');

    await app.find('.task-entry').trigger('click');
    await settle();
    expect(detail()).toContain('npm run build');
  });
});
