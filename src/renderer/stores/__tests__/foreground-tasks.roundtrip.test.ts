/**
 * Foreground tasks: kept out of the background tasks list, and a call in the
 * discussion opens the same view of its task as the list does.
 *
 * Reported as: "tasks appear in background tasks even when not
 * backgrounded", and clicking a task in the discussion showed far less than
 * clicking it in the background tasks list. The CLI (2.1.280) opens a task
 * for every command and agent and says which run in the foreground
 * (`is_backgrounded`); one user's main.log held 128 foreground commands, all
 * of which were listed as background tasks, 39 of them later moved to the
 * background by the CLI.
 *
 * Real ChatWindow, real stores, real preload, real conversation IPC handlers
 * and the real ConversationService, as in background-task-detail.roundtrip.
 */

import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { LiveBackgroundTask, TaskNotification, TaskOutputChunk, ToolCaptureData, ToolResultData } from '@shared/types';

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
import transcriptFixture from '../../../main/services/claude/__tests__/fixtures/agent-transcript.json';
import { transcriptToMessages } from '../../../main/services/claude/task-output';
import '../../../preload/preload';
import ChatWindow from '../../components/chat/ChatWindow.vue';
import { useChatStore } from '../chat';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import {
  startRealStack, settle, onDisk, emitIpc, mainHandlers, mountApp, unmountApp, send,
} from './support/real-stack';

const transcript = transcriptFixture as unknown as SessionMessage[];

/** Words from the fixture agent's prompt: shown only by the agent's own view. */
const AGENT_PROMPT = 'Read notes.txt, then use the Bash tool';

describe('foreground tasks', () => {
  let store: ReturnType<typeof useConversationsStore>;
  let chat: ReturnType<typeof useChatStore>;
  let app: ReturnType<typeof mount>;
  let conversationId: string;
  /** Tool results main has written, by output file. */
  let results: Map<string, string>;

  function notify(notification: TaskNotification): void {
    emitIpc('claude:task-notification', conversationId, notification);
  }

  function liveSet(tasks: Partial<LiveBackgroundTask>[]): void {
    emitIpc('claude:background-tasks-changed', conversationId, tasks.map((t) => ({
      taskType: 'local_bash', description: '', ambient: false, ...t,
    })));
  }

  /** A tool call in the discussion, and later its result, as main sends them. */
  function call(capture: ToolCaptureData): void {
    emitIpc('claude:tool-capture', conversationId, capture);
  }

  function result(toolUseBlockId: string, content: string, extra: Partial<ToolResultData> = {}): void {
    const outputFile = `/results/${toolUseBlockId}.txt`;
    results.set(outputFile, content);
    emitIpc('claude:tool-result', conversationId, { toolUseBlockId, outputFile, ...extra });
  }

  function panelRows(): string[] {
    return app.findAll('.background-task-panel .task-item').map((row) => row.text().replace(/\s+/g, ' '));
  }

  function dialog(title: string): HTMLElement | null {
    return [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')]
      .find((d) => d.textContent?.includes(title)) ?? null;
  }

  /** Click the discussion's row for the call whose row reads `text`. */
  async function clickCall(text: string): Promise<void> {
    const row = app.findAll('.tool-use-entry').find((r) => r.text().includes(text));
    expect(row, `expected a call in the discussion reading "${text}"`).toBeDefined();
    await row!.trigger('click');
    await settle(20);
  }

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

  async function restart(): Promise<void> {
    unmountApp();
    document.body.innerHTML = '';
    setActivePinia(createPinia());
    await startApp();
    await store.switchConversation(conversationId);
    await settle(20);
  }

  beforeEach(async () => {
    await startRealStack({
      ConversationService: ConversationService as unknown as new () => never,
      setupConversationIPC: setupConversationIPC as unknown as (service: never) => void,
    });
    mainHandlers.set('claude:send', () => undefined);
    results = new Map();
    mainHandlers.set('files:read', (_event, file) => results.get(file as string) ?? '');
    mainHandlers.set('claude:get-agent-transcript', () =>
      transcriptToMessages(transcript, (id, content) => {
        results.set(`/results/${id}.txt`, content);
        return `/results/${id}.txt`;
      }));
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

  describe('the background tasks list', () => {
    beforeEach(async () => {
      call({ toolUseBlockId: 'toolu_ls', toolName: 'Bash', input: { command: 'ls' }, description: 'Run: ls' });
      // task_started for a command the call waits on: is_backgrounded false.
      notify({ taskId: 'b-ls', status: 'running', description: 'List files', toolUseId: 'toolu_ls', taskType: 'command', backgrounded: false });
      await settle(20);
    });

    it('does not list a command running in the foreground', () => {
      expect(app.find('.background-task-panel').exists()).toBe(false);
      expect(chat.runningBackgroundTasksList).toEqual([]);
    });

    it('lists it once the CLI moves it to the background', async () => {
      // task_updated { patch: { is_backgrounded: true } }, as the handler passes it on.
      notify({ taskId: 'b-ls', status: 'running', backgrounded: true });
      await settle(20);

      expect(panelRows()).toEqual([expect.stringContaining('List files')]);
    });

    it('does not retire a running foreground command when the live set changes', async () => {
      // The live set lists background tasks only. Retiring everything else
      // marked this command stopped while it was still running.
      liveSet([{ taskId: 'b-other', description: 'Something else' }]);
      await settle(20);

      expect(chat.backgroundTasksList.find((t) => t.id === 'b-ls')?.status).toBe('running');
    });

    it('does not take a foreground command for a background one with the same description', async () => {
      // The same command, run again in the background. Adopting by
      // description must not re-key the foreground one to the other's id.
      liveSet([{ taskId: 'b-again', description: 'List files' }]);
      await settle(20);

      expect(chat.backgroundTasksList.find((t) => t.id === 'b-ls')?.status).toBe('running');
    });
  });

  describe('a call in the discussion', () => {
    it("opens an agent that ran in the foreground on the agent's own view", async () => {
      call({
        toolUseBlockId: 'toolu_agent', toolName: 'Agent',
        input: { description: 'Agent reads notes.txt', subagent_type: 'builder', prompt: AGENT_PROMPT },
        description: 'Agent: Agent reads notes.txt',
      });
      notify({ taskId: 'agent-1', status: 'running', description: 'Agent reads notes.txt', toolUseId: 'toolu_agent', taskType: 'agent', agentType: 'builder', backgrounded: false });
      await settle(20);

      await clickCall('Agent');

      const view = dialog('Task Details');
      expect(view, 'expected the task view, not Tool Details').not.toBeNull();
      expect(view!.textContent).toContain(AGENT_PROMPT);
      expect(dialog('Tool Details')).toBeNull();
    });

    it('opens a background command on its live output, not on its launch result', async () => {
      call({ toolUseBlockId: 'toolu_build', toolName: 'Bash', input: { command: 'npm run build', run_in_background: true }, description: 'Run: npm run build' });
      notify({ taskId: 'toolu_build', toolUseId: 'toolu_build', status: 'running', description: 'npm run build', backgrounded: true });
      result('toolu_build', 'Command running in background with ID: b-build');
      notify({ taskId: 'b-build', status: 'running', previousTaskId: 'toolu_build', backgrounded: true });
      await settle(20);

      await clickCall('npm run build');

      const view = dialog('Task Details');
      expect(view, 'expected the task view').not.toBeNull();
      expect(view!.textContent).toContain('build line 1');
    });

    it('opens a foreground command in Tool Details, where its result is its output', async () => {
      call({ toolUseBlockId: 'toolu_ls', toolName: 'Bash', input: { command: 'ls' }, description: 'Run: ls' });
      notify({ taskId: 'b-ls', status: 'running', description: 'List files', toolUseId: 'toolu_ls', taskType: 'command', backgrounded: false });
      result('toolu_ls', 'notes.txt\nsrc');
      notify({ taskId: 'b-ls', status: 'completed', toolUseId: 'toolu_ls' });
      await settle(20);

      await clickCall('ls');

      expect(dialog('Task Details')).toBeNull();
      expect(dialog('Tool Details')?.textContent).toContain('notes.txt');
    });
  });

  describe('after a restart', () => {
    async function agentCall(background: boolean): Promise<void> {
      call({
        toolUseBlockId: 'toolu_agent', toolName: 'Agent',
        input: { description: 'Agent reads notes.txt', subagent_type: 'builder', prompt: AGENT_PROMPT },
        description: 'Agent: Agent reads notes.txt',
      });
      notify({ taskId: 'agent-1', status: 'running', description: 'Agent reads notes.txt', toolUseId: 'toolu_agent', taskType: 'agent', agentType: 'builder', backgrounded: background });
      result('toolu_agent', background ? 'Async agent launched' : 'ok', { agent: { id: 'agent-1', background } });
      await settle(20);
    }

    it("still opens an agent's call on the agent's view, saying it completed", async () => {
      await agentCall(false);
      notify({ taskId: 'agent-1', status: 'completed', summary: 'Read it all', toolUseId: 'toolu_agent' });
      emitIpc('claude:done', conversationId);
      await settle(20);

      await restart();
      await clickCall('Agent');

      const view = dialog('Task Details');
      expect(view, 'expected the task view after a restart').not.toBeNull();
      expect(view!.textContent).toContain(AGENT_PROMPT);
      expect(view!.textContent).toContain('builder');
      expect(view!.textContent).toContain('Completed');
      expect(view!.textContent).toContain('Read it all');
    });

    it('says how a background agent ended, which its call does not', async () => {
      // The call finishes when the agent is launched; the agent's end comes
      // later, as a notification, and is what the saved record must say.
      await agentCall(true);
      emitIpc('claude:done', conversationId);
      await settle(20);
      notify({ taskId: 'agent-1', status: 'failed', error: 'ran out of turns', toolUseId: 'toolu_agent' });
      await settle(20);
      // A save after the end, as any later change to the discussion makes.
      await send(app, 'and then?');
      await settle(20);

      expect(onDisk(conversationId)?.messages.find((m) => m.toolUse?.task)?.toolUse?.task?.status).toBe('failed');

      await restart();
      await clickCall('Agent');

      const view = dialog('Task Details');
      expect(view!.textContent).toContain('Failed');
      expect(view!.textContent).toContain('ran out of turns');
    });

    it('does not show an agent that was running when the app quit as still running', async () => {
      await agentCall(true);
      emitIpc('claude:done', conversationId);
      await settle(20);

      await restart();
      await clickCall('Agent');

      const view = dialog('Task Details');
      expect(view!.textContent).toContain('Stopped');
      expect(view!.textContent).not.toContain('Stop task');
    });
  });
});
