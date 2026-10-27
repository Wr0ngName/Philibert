/**
 * The background tasks panel and the task detail view, through the real path.
 *
 * Reported as unusable: the panel showed much less than the CLI's ("builder
 * Reworking fetchItem in useCrudStore.ts  8m 0s · ↓ 160.8k tokens"), gave no
 * way to tell a command the main conversation ran from one an agent ran, a
 * command's detail showed no output, an agent's showed none of what it said
 * or did, and every update reset the scroll.
 *
 * Real ChatWindow, real stores, real preload, real conversation IPC handlers
 * and the real ConversationService. Task events arrive the way the main
 * process delivers them; the main process's answers for a transcript come
 * from its real converter, over what getSubagentMessages returned for a real
 * agent (CLI 2.1.280).
 */

import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { mount } from '@vue/test-utils';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { TaskNotification, TaskOutputChunk } from '@shared/types';

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
import { TASK_FEED_INTERVAL_MS } from '../../composables/useTaskDetailFeed';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import {
  startRealStack, settle, emitIpc, mainHandlers, mountApp, unmountApp, send,
} from './support/real-stack';

const transcript = transcriptFixture as unknown as SessionMessage[];

describe('background tasks, panel and detail', () => {
  let store: ReturnType<typeof useConversationsStore>;
  let app: ReturnType<typeof mount>;
  let conversationId: string;
  /** How many entries of the agent's transcript exist so far. */
  let transcriptLength: number;
  let transcriptReads: number;
  /** The command's output file, as it grows. */
  let commandOutput: string;
  let outputReads: number;

  function notify(notification: TaskNotification): void {
    emitIpc('claude:task-notification', conversationId, notification);
  }

  /** The panel's rows, as text, with the depth each sits at. */
  function panelRows(): { text: string; depth: number }[] {
    return app.findAll('.background-task-panel .task-item').map((row) => ({
      text: row.text().replace(/\s+/g, ' '),
      depth: Number(row.attributes('data-depth')),
    }));
  }

  function dialog(title: string): HTMLElement | null {
    return [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')]
      .find((d) => d.textContent?.includes(title)) ?? null;
  }

  async function openTask(text: string): Promise<HTMLElement> {
    const row = app.findAll('.background-task-panel .task-item').find((r) => r.text().includes(text));
    expect(row, `expected a panel row with "${text}"`).toBeDefined();
    await row!.trigger('click');
    await settle(20);
    const modal = dialog('Background Task Details');
    expect(modal, 'expected the task detail to open').not.toBeNull();
    return modal!;
  }

  async function tick(): Promise<void> {
    vi.advanceTimersByTime(TASK_FEED_INTERVAL_MS);
    await settle(20);
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await startRealStack({
      ConversationService: ConversationService as unknown as new () => never,
      setupConversationIPC: setupConversationIPC as unknown as (service: never) => void,
    });
    mainHandlers.set('claude:send', () => undefined);

    transcriptLength = 4;
    transcriptReads = 0;
    // Where main keeps a call's result for the tool detail, and reads it back.
    const results = new Map<string, string>();
    mainHandlers.set('claude:get-agent-transcript', () => {
      transcriptReads += 1;
      return transcriptToMessages(transcript.slice(0, transcriptLength), (id, content) => {
        results.set(`/results/${id}.txt`, content);
        return `/results/${id}.txt`;
      });
    });
    mainHandlers.set('files:read', (_event, file) => results.get(file as string) ?? '');

    commandOutput = 'main line 1\n';
    outputReads = 0;
    mainHandlers.set('claude:read-task-output', (_event, _conversation, _task, _file, fromByte): TaskOutputChunk => {
      outputReads += 1;
      const from = fromByte as number;
      return { text: commandOutput.slice(from), nextByte: commandOutput.length, skippedBytes: 0 };
    });

    store = useConversationsStore();
    const settings = useSettingsStore();
    settings.config.workingDirectory = '/home/user/project';
    settings.config.apiKey = 'test-key';
    await store.loadConversationList();
    await settle();
    app = mountApp(ChatWindow);
    await settle();

    store.createNewConversation();
    conversationId = store.currentConversationId!;
    await send(app, 'start the work');

    // An agent and a command from the main conversation, and a command the
    // agent started — the shapes the main process sends for them.
    notify({ taskId: 'agent-1', status: 'running', description: 'Agent reads notes.txt', toolUseId: 'toolu_agent', taskType: 'agent', agentType: 'builder' });
    notify({ taskId: 'bash-main', status: 'running', description: 'Run the main loop', toolUseId: 'toolu_main', taskType: 'command' });
    notify({ taskId: 'bash-agent', status: 'running', description: 'Run the agent loop', toolUseId: 'toolu_sub', taskType: 'command', parentTaskId: 'agent-1' });
    notify({ taskId: 'agent-1', status: 'running', activity: 'Reworking fetchItem in useCrudStore.ts', totalTokens: 160_800, toolUses: 3, agentType: 'builder', toolUseId: 'toolu_agent' });
    await settle(20);
  });

  afterEach(() => {
    unmountApp();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it("reads like the CLI's row: the agent's type, what it is doing, time and tokens", () => {
    const agentRow = panelRows().find((r) => r.text.includes('builder'));
    expect(agentRow?.text).toContain('Reworking fetchItem in useCrudStore.ts');
    expect(agentRow?.text).toContain('↓ 160.8k tokens');
    // What it is for is still there, in its title, not overwritten.
    const row = app.findAll('.background-task-panel .task-item').find((r) => r.text().includes('builder'));
    expect(row?.attributes('title')).toBe('Agent reads notes.txt');
  });

  it('puts what an agent started under that agent, and what the main conversation started at the top', () => {
    expect(panelRows().map((r) => [r.text.includes('builder') ? 'agent' : r.text.includes('agent loop') ? 'agent-cmd' : 'main-cmd', r.depth])).toEqual([
      ['agent', 0],
      ['agent-cmd', 1],
      ['main-cmd', 0],
    ]);
  });

  it("shows an agent's prompt, messages and calls through the discussion's own list", async () => {
    const modal = await openTask('builder');

    // The same rows the discussion is drawn with.
    expect(modal.querySelectorAll('.chat-row').length).toBeGreaterThan(0);
    expect(modal.textContent).toContain('Read notes.txt, then use the Bash tool');
    expect(modal.querySelector('.tool-use-entry')?.textContent).toContain('Read');
    // Its turns are the agent's, and its prompt is Claude's — not the user's.
    expect(modal.querySelector('.assistant-turn-header')?.textContent).toContain('builder');
    const prompt = modal.querySelector('.message-user .message-header')?.textContent ?? '';
    expect(prompt).toContain('Claude');
    expect(prompt).not.toContain('You');
  });

  it("follows a running agent, adding to what is shown rather than reloading it", async () => {
    const modal = await openTask('builder');
    expect(transcriptReads).toBe(1);
    const before = modal.querySelectorAll('.tool-use-entry').length;

    // Progress replaces the task's record many times a minute. That alone
    // must not reload the view — the reload is what kept resetting the scroll.
    notify({ taskId: 'agent-1', status: 'running', activity: 'Running the tests', totalTokens: 170_000, toolUses: 4, toolUseId: 'toolu_agent' });
    await settle(20);
    expect(transcriptReads).toBe(1);
    expect(modal.textContent).not.toContain("Loading the agent's transcript");

    transcriptLength = transcript.length;
    await tick();
    expect(transcriptReads).toBe(2);
    expect(modal.querySelectorAll('.tool-use-entry').length).toBeGreaterThan(before);
    expect(modal.textContent).toContain('Task complete');
  });

  it("opens one of the agent's calls in the tool detail", async () => {
    const modal = await openTask('builder');

    modal.querySelector<HTMLElement>('.tool-use-entry')!.click();
    await settle(20);

    // The call, with its result: the file the agent read.
    const detail = dialog('Tool Details');
    expect(detail?.textContent).toContain('Read');
    expect(detail?.textContent).toContain('alpha');
  });

  it("shows a running command's output, and what it writes next", async () => {
    const modal = await openTask('main loop');
    expect(modal.textContent).toContain('main line 1');

    notify({ taskId: 'bash-main', status: 'running', description: 'Run the main loop', toolUseId: 'toolu_main' });
    await settle(20);
    expect(outputReads).toBe(1);

    commandOutput += 'main line 2\n';
    await tick();
    expect(modal.querySelector('pre')?.textContent).toBe('main line 1\nmain line 2\n');
  });

  it('shows the command line of a command an agent started, which is not in the discussion', async () => {
    // As main.log recorded it (2026-10-27): the agent's Bash call, carried
    // on the task because the discussion has no tool_use for it.
    const command = 'cd C:/Users/u/proj && powershell -NoProfile -File tools/test/regress.ps1 -Suites "VectorShapesSelfTest"';
    notify({
      taskId: 'bash-agent', status: 'running', description: 'Run the agent loop', toolUseId: 'toolu_sub',
      toolName: 'Bash', toolInput: { command, description: 'Run the agent loop', run_in_background: true },
    });
    await settle(20);

    const modal = await openTask('agent loop');

    expect(modal.textContent).toContain(command);
    expect(modal.textContent).toContain('Bash');
  });

  it('tells a command that has printed nothing from one with no output file', async () => {
    commandOutput = '';
    let modal = await openTask('main loop');
    expect(modal.textContent).toContain('Nothing printed yet');

    (modal.querySelector('[aria-label="Close"]') as HTMLElement | null)?.click();
    await settle(20);
    mainHandlers.set('claude:read-task-output', () => null);
    modal = await openTask('agent loop');
    expect(modal.textContent).toContain('No output file yet');
  });

  it('says which agent started a command, and opens it', async () => {
    const modal = await openTask('agent loop');

    const link = [...modal.querySelectorAll('button')].find((b) => b.textContent?.includes('Started by builder'));
    expect(link, 'expected a link to the agent that started it').toBeDefined();
    link!.click();
    await settle(20);

    expect(dialog('Background Task Details')?.textContent).toContain('Agent reads notes.txt');
  });
});
