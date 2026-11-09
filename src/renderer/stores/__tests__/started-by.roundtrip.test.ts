/**
 * Where a task, an agent or a tool call came from, in their detail views.
 *
 * Reported: a command an agent had started was still listed as running long
 * after the agent had replied, with nothing to say which agent it belonged
 * to. An agent's background command outlives the agent's reply — the CLI
 * keeps it, and wakes the agent when it ends — so the details now say who
 * started it, whether that agent is still running or not.
 *
 * Real ChatWindow, real stores, real preload, real conversation IPC handlers
 * and the real ConversationService. Calls and task events arrive the way the
 * main process delivers them.
 */

import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { TaskNotification, TaskOutputChunk, ToolCaptureData, ToolResultData } from '@shared/types';

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
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import {
  startRealStack, settle, emitIpc, mainHandlers, mountApp, unmountApp, send,
} from './support/real-stack';

const transcript = transcriptFixture as unknown as SessionMessage[];

/** Words from the fixture agent's prompt: shown only by the agent's own view. */
const AGENT_PROMPT = 'Read notes.txt, then use the Bash tool';

describe('who started it, in the details', () => {
  let store: ReturnType<typeof useConversationsStore>;
  let app: ReturnType<typeof mount>;
  let conversationId: string;
  let results: Map<string, string>;

  function notify(notification: TaskNotification): void {
    emitIpc('claude:task-notification', conversationId, notification);
  }

  function call(capture: ToolCaptureData): void {
    emitIpc('claude:tool-capture', conversationId, capture);
  }

  function result(toolUseBlockId: string, content: string, extra: Partial<ToolResultData> = {}): void {
    const outputFile = `/results/${toolUseBlockId}.txt`;
    results.set(outputFile, content);
    emitIpc('claude:tool-result', conversationId, { toolUseBlockId, outputFile, ...extra });
  }

  function dialog(title: string): HTMLElement | null {
    return [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')]
      .find((d) => d.textContent?.includes(title)) ?? null;
  }

  /**
   * The "Started by" line of an open dialog, as read: its parts are spaced
   * by the layout, not by text, so they are joined with a space here.
   */
  function startedBy(title: string): string | null {
    const line = dialog(title)?.querySelector('.started-by');
    if (!line) return null;
    return [...line.querySelectorAll('span')].map((part) => (part.textContent ?? '').trim()).join(' ');
  }

  /** Show the calls an agent made, under its call in the discussion. */
  async function expandAgent(): Promise<void> {
    const toggle = app.find('[title="Expand sub-agent actions"]');
    expect(toggle.exists(), 'expected the agent call to have actions to expand').toBe(true);
    await toggle.trigger('click');
    await settle(20);
  }

  async function openPanelRow(text: string): Promise<void> {
    const row = app.findAll('.background-task-panel .task-item').find((r) => r.text().includes(text));
    expect(row, `expected a panel row with "${text}"`).toBeDefined();
    await row!.trigger('click');
    await settle(20);
  }

  async function clickCall(text: string): Promise<void> {
    const row = app.findAll('.tool-use-entry').find((r) => r.text().includes(text));
    const rows = app.findAll('.tool-use-entry').map((r) => r.text().replace(/\s+/g, ' '));
    expect(row, `expected a call in the discussion reading "${text}", among ${JSON.stringify(rows)}`).toBeDefined();
    await row!.trigger('click');
    await settle(20);
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

  /** A background agent, as main reports one: its call, task_started, its launch result. */
  async function launchAgent(name?: string): Promise<void> {
    call({
      toolUseBlockId: 'toolu_agent', toolName: 'Agent',
      input: {
        description: 'Agent reads notes.txt', subagent_type: 'builder', prompt: AGENT_PROMPT, run_in_background: true,
        ...(name ? { name } : {}),
      },
      description: 'Agent: Agent reads notes.txt',
    });
    notify({
      taskId: 'agent-1', status: 'running', description: 'Agent reads notes.txt', toolUseId: 'toolu_agent',
      taskType: 'agent', agentType: 'builder', backgrounded: true,
    });
    result('toolu_agent', 'Async agent launched', { agent: { id: 'agent-1', background: true } });
    await settle(20);
  }

  /**
   * The agent's own command, as main.log has task bfzfyzh0g: a foreground
   * call inside the agent's frames, its task_started owned_by_subagent, and
   * then moved to the background at its timeout. Main linked it to no agent.
   */
  async function agentCommand(): Promise<void> {
    call({
      toolUseBlockId: 'toolu_check', toolName: 'Bash', parentToolUseId: 'toolu_agent',
      input: { command: 'which python3 perl sed | head', description: 'Check available tools' },
      description: 'Check available tools',
    });
    notify({
      taskId: 'b-check', status: 'running', description: 'Check available tools', toolUseId: 'toolu_check',
      taskType: 'command', backgrounded: false, startedByAgent: true,
    });
    notify({ taskId: 'b-check', status: 'running', backgrounded: true });
    await settle(20);
  }

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
    results = new Map();
    mainHandlers.set('files:read', (_event, file) => results.get(file as string) ?? '');
    mainHandlers.set('claude:get-agent-transcript', () =>
      transcriptToMessages(transcript, (id, content) => {
        results.set(`/results/${id}.txt`, content);
        return `/results/${id}.txt`;
      }));
    mainHandlers.set('claude:read-task-output', (): TaskOutputChunk => ({ text: '', nextByte: 0, skippedBytes: 0 }));

    await startApp();
    store.createNewConversation();
    conversationId = store.currentConversationId!;
    await send(app, 'start the work');
  });

  afterEach(() => {
    unmountApp();
    document.body.innerHTML = '';
  });

  it("names the agent of a command it left running, after the agent has finished, and opens it", async () => {
    await launchAgent();
    await agentCommand();
    notify({ taskId: 'agent-1', status: 'completed', toolUseId: 'toolu_agent', summary: 'Done' });
    await settle(20);

    await openPanelRow('Check available tools');

    expect(startedBy('Task Details')).toBe('Started by builder — Agent reads notes.txt (finished)');
    (dialog('Task Details')!.querySelector('.started-by button') as HTMLElement).click();
    await settle(20);
    expect(dialog('Task Details')?.textContent).toContain(AGENT_PROMPT);
  });

  it('still names that agent after a restart, from the calls kept with the conversation', async () => {
    await launchAgent();
    await agentCommand();
    notify({ taskId: 'agent-1', status: 'completed', toolUseId: 'toolu_agent', summary: 'Done' });
    await settle(20);
    await endTurn();
    await restart();

    await expandAgent();
    await clickCall('Check available tools');

    expect(startedBy('Task Details')).toContain('Started by builder — Agent reads notes.txt');
  });

  it('finds the agent by the task it runs when its call is not in the discussion', async () => {
    // The Agent call is not among the messages shown — far back in a long
    // conversation — but the agent's task is tracked under that call's id.
    notify({
      taskId: 'agent-1', status: 'running', description: 'Agent reads notes.txt', toolUseId: 'toolu_agent',
      taskType: 'agent', agentType: 'builder', backgrounded: true,
    });
    await agentCommand();

    await openPanelRow('Check available tools');

    expect(startedBy('Task Details')).toBe('Started by builder — Agent reads notes.txt (running)');
  });

  // Reported, from main.log: an agent resumed after the app restarted started
  // an agent of its own, listed at the top of the tasks list while its
  // details said an agent had started it. Main knew the resumed agent only by
  // the SendMessage call that resumed it, while the CLI named its original
  // Agent call as the new agent's parent: main sent startedByAgent and no
  // parentTaskId, and the list nested by parentTaskId alone.
  it("lists an agent started by an agent resumed after a restart under that agent, as its details say", async () => {
    await launchAgent();
    await endTurn();
    await restart();

    // Resumed by a message, as main reports it: under the SendMessage call.
    call({
      toolUseBlockId: 'toolu_resume', toolName: 'SendMessage',
      input: { to: 'agent-1', message: 'Resume from your handoff' }, description: 'SendMessage: agent-1',
    });
    notify({
      taskId: 'agent-1', status: 'running', description: 'Agent reads notes.txt', toolUseId: 'toolu_resume',
      taskType: 'agent', backgrounded: true,
    });
    // The agent starts one of its own: its call names the ORIGINAL Agent call.
    call({
      toolUseBlockId: 'toolu_nested', toolName: 'Agent', parentToolUseId: 'toolu_agent',
      input: { description: 'Client ghost research', subagent_type: 'Explore', prompt: 'Research', run_in_background: true },
      description: 'Agent: Client ghost research',
    });
    notify({
      taskId: 'agent-2', status: 'running', description: 'Client ghost research', toolUseId: 'toolu_nested',
      taskType: 'agent', agentType: 'Explore', backgrounded: true, startedByAgent: true,
    });
    await settle(20);

    const rows = app.findAll('.background-task-panel .task-item').map((row) => ({
      text: row.text(), depth: Number(row.attributes('data-depth')),
    }));
    expect(rows.map((row) => [row.text.includes('Client ghost research') ? 'nested' : 'agent', row.depth])).toEqual([
      ['agent', 0],
      ['nested', 1],
    ]);

    // The details name the same agent the list puts it under.
    await openPanelRow('Client ghost research');
    expect(startedBy('Task Details')).toContain('— Agent reads notes.txt (running)');
  });

  it('says an agent started it when the CLI says so but the agent is not known here', async () => {
    notify({
      taskId: 'b-orphan', status: 'running', description: 'Wait for the snapshot', toolUseId: 'toolu_gone',
      taskType: 'command', backgrounded: true, startedByAgent: true,
    });
    await settle(20);

    await openPanelRow('Wait for the snapshot');

    expect(startedBy('Task Details')).toBe('Started by an agent');
  });

  it('says the main conversation started a command it ran itself', async () => {
    call({
      toolUseBlockId: 'toolu_build', toolName: 'Bash',
      input: { command: 'npm run build', description: 'Build the app', run_in_background: true },
      description: 'Build the app',
    });
    notify({ taskId: 'b-build', status: 'running', description: 'Build the app', toolUseId: 'toolu_build', taskType: 'command', backgrounded: true });
    await settle(20);

    await openPanelRow('Build the app');

    expect(startedBy('Task Details')).toBe('Started by the main conversation');
  });

  it("names the agent that made a call in Tool Details, and opens the agent's details from there", async () => {
    await launchAgent();
    call({
      toolUseBlockId: 'toolu_read', toolName: 'Read', parentToolUseId: 'toolu_agent',
      input: { file_path: '/home/user/project/notes.txt' }, description: 'Read notes.txt',
    });
    result('toolu_read', 'alpha');
    await settle(20);

    await expandAgent();
    await clickCall('Read: /home/user/project/notes.txt');

    expect(startedBy('Tool Details')).toBe('Started by builder — Agent reads notes.txt (running)');
    (dialog('Tool Details')!.querySelector('.started-by button') as HTMLElement).click();
    await settle(20);
    expect(dialog('Tool Details')).toBeNull();
    expect(dialog('Task Details')?.textContent).toContain(AGENT_PROMPT);
  });

  it("names the agent for a call opened from that agent's transcript", async () => {
    await launchAgent();
    await openPanelRow('builder');

    dialog('Task Details')!.querySelector<HTMLElement>('.tool-use-entry')!.click();
    await settle(20);

    expect(startedBy('Tool Details')).toBe('Started by builder — Agent reads notes.txt (running)');
  });

  describe('a message sent to an agent', () => {
    const MESSAGE = 'when you are done, also run echo hello';

    /** SendMessage as the CLI gives it: the agent's id or name in `to`, and again in `recipient`. */
    async function sendToAgent(address: string, extra: Record<string, unknown> = {}): Promise<void> {
      call({
        toolUseBlockId: 'toolu_send', toolName: 'SendMessage',
        input: { to: address, message: MESSAGE, type: 'message', recipient: address, content: MESSAGE, ...extra },
        description: '',
      });
      result('toolu_send', `{"success":true,"message":"Message queued for delivery to ${address} at its next tool round."}`);
      await settle(20);
    }

    /** The row of the SendMessage call in the discussion; its parts are spans, read without spacing. */
    const row = () => app.findAll('.tool-use-entry').find((r) => r.text().includes('SendMessage'))!.text();

    it('reads in the discussion by its summary', async () => {
      await launchAgent();
      await sendToAgent('agent-1', { summary: 'Also run echo hello' });
      expect(row()).toContain('SendMessageAlso run echo hello');
    });

    it('without a summary, reads by the first line of its message', async () => {
      await launchAgent();
      await sendToAgent('agent-1');
      expect(row()).toContain(`SendMessage${MESSAGE}`);
    });

    it('names the agent it went to by the name its Agent call gave it', async () => {
      await launchAgent('reader');
      await sendToAgent('reader');

      await clickCall('SendMessage');

      expect(read(inputRow('To'))).toBe('builder — Agent reads notes.txt (running)');
    });

    /** The Input rows of the open Tool Details, label and value, as read. */
    function inputRow(label: string): HTMLElement | null {
      return [...dialog('Tool Details')!.querySelectorAll<HTMLElement>('.flex.items-baseline')]
        .find((row) => row.firstElementChild?.textContent?.trim() === label) ?? null;
    }
    const read = (row: HTMLElement | null) =>
      [...(row?.querySelectorAll('.agent-link span') ?? [])].map((part) => (part.textContent ?? '').trim()).join(' ');

    it('names the agent it went to rather than its id, and opens the agent from there', async () => {
      await launchAgent();
      await sendToAgent('agent-1');

      await clickCall('SendMessage');

      expect(read(inputRow('To'))).toBe('builder — Agent reads notes.txt (running)');
      expect(read(inputRow('Recipient'))).toBe('builder — Agent reads notes.txt (running)');
      expect(inputRow('To')!.textContent).not.toContain('agent-1');
      expect(dialog('Tool Details')!.textContent).toContain(MESSAGE);

      inputRow('To')!.querySelector<HTMLElement>('.agent-link')!.click();
      await settle(20);
      expect(dialog('Tool Details')).toBeNull();
      expect(dialog('Task Details')?.textContent).toContain(AGENT_PROMPT);
    });

    it('still names it after the agent finished and the app restarted', async () => {
      await launchAgent();
      await sendToAgent('agent-1');
      notify({ taskId: 'agent-1', status: 'completed', toolUseId: 'toolu_agent', summary: 'Done' });
      await settle(20);
      await endTurn();
      await restart();

      await clickCall('SendMessage');

      expect(read(inputRow('To'))).toBe('builder — Agent reads notes.txt (finished)');
    });

    it('shows the id as it is when no agent here has it', async () => {
      await sendToAgent('a481e4eafefca67f3');

      await clickCall('SendMessage');

      expect(inputRow('To')!.querySelector('.agent-link')).toBeNull();
      expect(inputRow('To')!.textContent).toContain('a481e4eafefca67f3');
    });
  });

  it('says the main conversation made a call it made itself', async () => {
    call({ toolUseBlockId: 'toolu_ls', toolName: 'Bash', input: { command: 'ls' }, description: 'Run: ls' });
    result('toolu_ls', 'notes.txt');
    await settle(20);

    await clickCall('ls');

    expect(startedBy('Tool Details')).toBe('Started by the main conversation');
  });
});
