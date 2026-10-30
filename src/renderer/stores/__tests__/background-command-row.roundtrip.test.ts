/**
 * A command run in the background has one row in the discussion: its call.
 *
 * Reported as a background command appearing twice — its Bash call, and a
 * separate "Task" row. The first notice of the task (the launch, read off the
 * call's `run_in_background`) did not name the call, so the renderer could
 * not tell the two were one. The call now stands for the task: it shows how
 * the task stands, and a conversation saved with both rows reads back with
 * one.
 *
 * The notices below are the ones main sends, in the order one user's
 * main.log has them for a background Bash (CLI 2.1.280): the launch, the
 * CLI's task_started naming the call, the call's result naming the task, and
 * the completion naming both.
 *
 * Real ChatWindow, real stores, real preload, real conversation IPC handlers
 * and the real ConversationService, as in foreground-tasks.roundtrip.
 */

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { ChatMessage, Conversation, TaskNotification, TaskOutputChunk, ToolResultData } from '@shared/types';

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
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import {
  startRealStack, settle, onDisk, emitIpc, mainHandlers, mountApp, unmountApp, send, files,
} from './support/real-stack';

const SUMMARY = 'Background command "npm run build" completed (exit code 0)';

describe('a background command in the discussion', () => {
  let store: ReturnType<typeof useConversationsStore>;
  let app: ReturnType<typeof mount>;
  let conversationId: string;

  function notify(notification: TaskNotification): void {
    emitIpc('claude:task-notification', conversationId, notification);
  }

  function result(toolUseBlockId: string, extra: Partial<ToolResultData> = {}): void {
    emitIpc('claude:tool-result', conversationId, { toolUseBlockId, outputFile: `/results/${toolUseBlockId}.txt`, ...extra });
  }

  /** A Bash call run in the background, up to the CLI saying which task it is. */
  async function launchBuild(): Promise<void> {
    emitIpc('claude:tool-capture', conversationId, {
      toolUseBlockId: 'toolu_build', toolName: 'Bash',
      input: { command: 'npm run build', run_in_background: true, description: 'Build the app' },
      description: 'Run: npm run build',
    });
    // The launch, from the call's run_in_background.
    notify({ taskId: 'toolu_build', toolUseId: 'toolu_build', status: 'running', description: 'Build the app', backgrounded: true });
    // task_started.
    notify({ taskId: 'b-build', toolUseId: 'toolu_build', status: 'running', description: 'Build the app', taskType: 'command', backgrounded: true });
    // The call's result, naming the task.
    result('toolu_build');
    notify({ taskId: 'b-build', previousTaskId: 'toolu_build', status: 'running', backgrounded: true });
    await settle(20);
  }

  function finish(status: 'completed' | 'failed', extra: Partial<TaskNotification> = {}): void {
    notify({
      taskId: 'b-build', toolUseId: 'toolu_build', status,
      outputFile: '/tmp/claude/tasks/b-build.output', ...extra,
    });
  }

  function callRows(): string[] {
    return app.findAll('.tool-use-entry').map((row) => row.text().replace(/\s+/g, ' '));
  }

  function taskRows(): string[] {
    return app.findAll('.task-entry').map((row) => row.text().replace(/\s+/g, ' '));
  }

  function dialog(title: string): HTMLElement | null {
    return [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')]
      .find((d) => d.textContent?.includes(title)) ?? null;
  }

  async function startApp(): Promise<void> {
    store = useConversationsStore();
    const settings = useSettingsStore();
    settings.config.workingDirectory = '/home/user/project';
    settings.config.apiKey = 'test-key';
    await store.loadConversationList();
    await settle();
    app = mountApp(ChatWindow);
    await settle();
  }

  async function restart(): Promise<void> {
    unmountApp();
    document.body.innerHTML = '';
    setActivePinia(createPinia());
    await startApp();
    await store.switchConversation(conversationId);
    await settle(20);
  }

  /** The turn ending, which saves the conversation. */
  async function endTurn(): Promise<void> {
    emitIpc('claude:done', conversationId);
    await settle(20);
  }

  beforeEach(async () => {
    await startRealStack({
      ConversationService: ConversationService as unknown as new () => never,
      setupConversationIPC: setupConversationIPC as unknown as (service: never) => void,
    });
    mainHandlers.set('claude:send', () => undefined);
    mainHandlers.set('files:read', () => 'Command running in background with ID: b-build');
    mainHandlers.set('claude:read-task-output', (): TaskOutputChunk => ({
      text: 'build line 1\n', nextByte: 13, skippedBytes: 0,
    }));

    await startApp();
    store.createNewConversation();
    conversationId = store.currentConversationId!;
    await send(app, 'start the work');
  });

  afterEach(() => {
    unmountApp();
    document.body.innerHTML = '';
  });

  it('has one row: its call', async () => {
    await launchBuild();

    expect(taskRows()).toEqual([]);
    expect(callRows()).toEqual([expect.stringContaining('npm run build')]);
  });

  it('says Running on its call while the command runs, though the call itself is done', async () => {
    await launchBuild();

    expect(callRows()[0]).toContain('Running');
    expect(callRows()[0]).not.toContain('Done');
  });

  it('says Done with what the command reported once it ends', async () => {
    await launchBuild();
    finish('completed', { summary: SUMMARY });
    await settle(20);

    expect(callRows()[0]).toContain('Done');
    expect(callRows()[0]).toContain(SUMMARY);
  });

  it('says Failed when the command fails', async () => {
    await launchBuild();
    finish('failed', { summary: 'Background command "npm run build" failed with exit code 1' });
    await settle(20);

    expect(callRows()[0]).toContain('Failed');
  });

  it('opens on its live output', async () => {
    await launchBuild();
    await app.findAll('.tool-use-entry')[0].trigger('click');
    await settle(20);

    expect(dialog('Task Details')?.textContent).toContain('build line 1');
  });

  it('still has its own row when no call in the discussion started it', async () => {
    notify({ taskId: 'b-elsewhere', status: 'running', description: 'Watch the logs', taskType: 'command', backgrounded: true });
    await settle(20);

    expect(taskRows()).toEqual([expect.stringContaining('Watch the logs')]);
  });

  describe('after a restart', () => {
    it('says how the command ended, and opens on it', async () => {
      await launchBuild();
      finish('completed', { summary: SUMMARY });
      await settle(20);
      await endTurn();

      await restart();

      expect(taskRows()).toEqual([]);
      expect(callRows()[0]).toContain('Done');
      expect(callRows()[0]).toContain(SUMMARY);

      await app.findAll('.tool-use-entry')[0].trigger('click');
      await settle(20);
      expect(dialog('Task Details')?.textContent).toContain(SUMMARY);
    });

    it('does not show a command that was running when the app quit as still running', async () => {
      await launchBuild();
      await endTurn();

      await restart();

      expect(callRows()[0]).toContain('Stopped');
      expect(callRows()[0]).not.toContain('Running');
    });
  });

  describe('a conversation saved with a row for the call and one for its task', () => {
    beforeEach(endTurn);
    /** The two rows as earlier versions stored them, and the turn around them. */
    function storedWithTaskRow(): Conversation {
      const stored = onDisk(conversationId)!;
      const call: ChatMessage = {
        id: 'msg_call', role: 'assistant', content: '', timestamp: 1000,
        toolUse: {
          actionId: 'toolu_old', toolName: 'Bash', description: 'Run: npm test', status: 'executed',
          toolUseBlockId: 'toolu_old', input: { command: 'npm test', run_in_background: true },
          outputFile: '/results/toolu_old.txt',
        },
      };
      // The row was added under the launch's id, which is the call's.
      const row: ChatMessage = {
        id: 'msg_row', role: 'assistant', content: '', timestamp: 1001,
        backgroundTask: {
          taskId: 'toolu_old', description: 'Run the tests', status: 'completed',
          startedAt: 1001, completedAt: 5000, summary: 'Background command "npm test" completed (exit code 0)',
          outputFile: '/tmp/claude/tasks/b-old.output',
        },
      };
      return { ...stored, messages: [...stored.messages, call, row] };
    }

    it('reads back with the one row, saying how the task ended', async () => {
      files.set(`/conversations/${conversationId}.json`, JSON.stringify(storedWithTaskRow()));

      await restart();

      expect(taskRows()).toEqual([]);
      expect(callRows()).toEqual([expect.stringContaining('npm test')]);
      expect(callRows()[0]).toContain('Done');
      expect(callRows()[0]).toContain('completed (exit code 0)');
    });

    it('is stored with the one row on its next save', async () => {
      files.set(`/conversations/${conversationId}.json`, JSON.stringify(storedWithTaskRow()));
      await restart();
      await send(app, 'and then?');
      await endTurn();

      const messages = onDisk(conversationId)!.messages;
      expect(messages.find((m) => m.id === 'msg_row')).toBeUndefined();
      expect(messages.find((m) => m.id === 'msg_call')?.toolUse?.task?.status).toBe('completed');
    });

    it("keeps an Agent call's record stored under its earlier name", async () => {
      const stored = onDisk(conversationId)!;
      const agentCall = {
        id: 'msg_agent', role: 'assistant', content: '', timestamp: 1000,
        toolUse: {
          actionId: 'toolu_agent', toolName: 'Agent', description: 'Agent: Review', status: 'executed',
          toolUseBlockId: 'toolu_agent', input: { description: 'Review', prompt: 'Review it' },
          agentTask: { taskId: 'agent-1', description: 'Review', status: 'failed', startedAt: 1000, error: 'ran out of turns' },
        },
      };
      files.set(`/conversations/${conversationId}.json`, JSON.stringify({ ...stored, messages: [...stored.messages, agentCall] }));

      await restart();

      expect(callRows()[0]).toContain('Failed');
    });
  });
});
