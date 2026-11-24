/**
 * Tool Details' input and output in a real browser, with the app's own
 * styles — happy-dom lays nothing out, so it cannot see a block's height.
 *
 * Reported: resizing the dialog left its input and output as small as they
 * were, each stopping at a height of its own (15 and 24rem) in a dialog dragged
 * much taller. Resized, they now share the room the dialog has; sized to its
 * content, they stop at those heights as before.
 *
 * Run with `npm run test:browser`.
 */

import '../../../assets/styles/main.css';

import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, type BackgroundTask, type ChatMessage, type ToolUseInfo } from '@shared/types';

import { useSettingsStore } from '../../../stores/settings';
import BackgroundTaskDetailModal from '../BackgroundTaskDetailModal.vue';
import ToolDetailModal from '../ToolDetailModal.vue';

const LONG = Array.from({ length: 400 }, (_, i) => `line ${i + 1} of what the command printed`).join('\n');
const COMMAND = Array.from({ length: 120 }, (_, i) => `echo step ${i + 1}`).join('\n');

const toolUse: ToolUseInfo = {
  actionId: 'action-1',
  toolName: 'Bash',
  description: 'Run the build',
  status: 'executed',
  input: { command: COMMAND, description: 'Run the build' },
  outputFile: '/tmp/output.txt',
};

let wrapper: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  useSettingsStore().config = { ...DEFAULT_CONFIG, modalSizes: {} };
  (window as unknown as { electron: unknown }).electron = {
    files: { read: async () => LONG },
    claude: {
      readTaskOutput: async () => ({ text: LONG, nextByte: LONG.length, skippedBytes: 0 }),
      getAgentTranscript: async (): Promise<ChatMessage[]> => Array.from({ length: 200 }, (_, i) => ({
        id: `t-${i}`, role: i % 2 ? 'assistant' : 'user', content: `Message ${i} of the agent's transcript.`, timestamp: i,
      })),
    },
  };
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

async function opened(): Promise<void> {
  wrapper = mount(ToolDetailModal, { props: { open: true, toolUse }, attachTo: document.body });
  await flushPromises();
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/** A block's height, by what it shows: the input's command, or the output. */
function heightOf(section: 'input' | 'output'): number {
  const block = document.querySelector<HTMLElement>(`[data-testid="tool-call-${section}"] .code-block`);
  if (!block) throw new Error(`no ${section} block`);
  return block.getBoundingClientRect().height;
}

const REM = 16;

/** How far the output block's bottom is from the bottom of the dialog's content box: 0 when it fills it. */
function gapBelowOutput(): number {
  const body = document.querySelector<HTMLElement>('[role="dialog"] .overflow-y-auto')!;
  const output = document.querySelector<HTMLElement>('[data-testid="tool-call-output"] .code-block')!;
  const padding = parseFloat(getComputedStyle(body).paddingBottom);
  return body.getBoundingClientRect().bottom - padding - output.getBoundingClientRect().bottom;
}

/** Whether the dialog's own content scrolls: it should not, its blocks scrolling themselves. */
function dialogScrolls(): boolean {
  const body = document.querySelector<HTMLElement>('[role="dialog"] .overflow-y-auto')!;
  return body.scrollHeight > body.clientHeight + 1;
}

describe("Tool Details' input and output", () => {
  it('sized to their content, stop at their own heights', async () => {
    await opened();

    expect(heightOf('input')).toBeLessThanOrEqual(15 * REM + 1);
    expect(heightOf('output')).toBeLessThanOrEqual(24 * REM + 1);
  });

  it('in a dialog resized taller, take the room it has, each in proportion to its text', async () => {
    useSettingsStore().config.modalSizes = { 'tool-detail': { width: 900, height: 780 } };
    await opened();

    // All of the room: down to the dialog's bottom, and no more — each block scrolls itself.
    expect(Math.abs(gapBelowOutput())).toBeLessThanOrEqual(2);
    expect(dialogScrolls()).toBe(false);
    // The output, the longer text, the larger share.
    expect(heightOf('output')).toBeGreaterThan(heightOf('input'));
  });

  it('with a short output, leave it its height, the rest to the input', async () => {
    (window as unknown as { electron: unknown }).electron = { files: { read: async () => 'Done.' } };
    useSettingsStore().config.modalSizes = { 'tool-detail': { width: 900, height: 780 } };
    await opened();

    expect(heightOf('output')).toBeLessThan(4 * REM + 1);
    expect(heightOf('input')).toBeGreaterThan(15 * REM);
  });

  it('with a short input and a long output, crush nothing: the input keeps its height, every line of it in view', async () => {
    useSettingsStore().config.modalSizes = { 'tool-detail': { width: 760, height: 560 } };
    wrapper = mount(ToolDetailModal, {
      props: { open: true, toolUse: { ...toolUse, input: { command: 'seq 1 400', description: 'Run seq 1 400' } } },
      attachTo: document.body,
    });
    await flushPromises();
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

    const command = document.querySelector<HTMLElement>('[data-testid="tool-call-input"] .code-block')!;
    const text = command.querySelector('pre')!.getBoundingClientRect().height;
    const padding = parseFloat(getComputedStyle(command).paddingTop) + parseFloat(getComputedStyle(command).paddingBottom);
    // Its line in full, not cut by a block shrunk below it — nor padded out beyond it.
    expect(Math.abs(command.getBoundingClientRect().height - (text + padding))).toBeLessThanOrEqual(2);
    // Each heading below what is above it: nothing drawn over anything.
    const headings = [...document.querySelectorAll<HTMLElement>('[data-testid^="tool-call-"] .text-xs.font-medium')];
    const tops = headings.map((heading) => heading.getBoundingClientRect().top);
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    const output = document.querySelector<HTMLElement>('[data-testid="tool-call-output"] .code-block')!;
    expect(output.getBoundingClientRect().top).toBeGreaterThanOrEqual(command.getBoundingClientRect().bottom);
    expect(Math.abs(gapBelowOutput())).toBeLessThanOrEqual(2);
  });

  it('with a short input, give the output more than it stops at sized to its content', async () => {
    useSettingsStore().config.modalSizes = { 'tool-detail': { width: 900, height: 780 } };
    wrapper = mount(ToolDetailModal, {
      props: { open: true, toolUse: { ...toolUse, input: { command: 'seq 1 400', description: 'Run seq 1 400' } } },
      attachTo: document.body,
    });
    await flushPromises();
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

    expect(heightOf('output')).toBeGreaterThan(24 * REM);
    expect(dialogScrolls()).toBe(false);
  });

  it('take a single long line for a long text: it wraps over many, and shrinks with the rest', async () => {
    useSettingsStore().config.modalSizes = { 'tool-detail': { width: 600, height: 500 } };
    wrapper = mount(ToolDetailModal, {
      props: { open: true, toolUse: { ...toolUse, input: { command: `echo ${'word '.repeat(600)}`, description: 'Echo' } } },
      attachTo: document.body,
    });
    await flushPromises();
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

    expect(dialogScrolls()).toBe(false);
    expect(heightOf('output')).toBeGreaterThanOrEqual(4 * REM);
  });

  it('in a dialog resized shorter, shrink with it, rather than make it scroll', async () => {
    useSettingsStore().config.modalSizes = { 'tool-detail': { width: 900, height: 420 } };
    await opened();

    expect(heightOf('output')).toBeLessThan(24 * REM);
    expect(dialogScrolls()).toBe(false);
  });
});

describe("Tool Details' input and output, in a dialog made as small as it goes", () => {
  it('keep a few lines each, the dialog scrolling rather than the blocks vanishing', async () => {
    useSettingsStore().config.modalSizes = { 'tool-detail': { width: 900, height: 1 } };
    await opened();

    expect(heightOf('input')).toBeGreaterThanOrEqual(4 * REM);
    expect(heightOf('output')).toBeGreaterThanOrEqual(4 * REM);
  });
});

describe("Task Details' command input and output, the same view", () => {
  const task: BackgroundTask = {
    id: 'b1', toolUseId: 'toolu_b1', taskType: 'command', toolName: 'Bash', description: 'Run the build',
    status: 'completed', startedAt: 1, completedAt: 2, toolInput: { command: COMMAND, description: 'Run the build' },
  } as BackgroundTask;

  it('in a dialog resized taller, take the room it has', async () => {
    useSettingsStore().config.modalSizes = { 'task-detail': { width: 900, height: 780 } };
    wrapper = mount(BackgroundTaskDetailModal, { props: { open: true, task, conversationId: 'c1' }, attachTo: document.body });
    await flushPromises();
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

    expect(Math.abs(gapBelowOutput())).toBeLessThanOrEqual(2);
    expect(dialogScrolls()).toBe(false);
  });
});

describe("an agent's Task Details: its transcript", () => {
  const agent: BackgroundTask = {
    id: 'agent-1', toolUseId: 'toolu_agent', taskType: 'agent', description: 'Research',
    status: 'completed', startedAt: 1, completedAt: 2,
  } as BackgroundTask;

  async function openedAt(height: number | null): Promise<{ transcript: number; scrolls: boolean }> {
    useSettingsStore().config.modalSizes = height === null ? {} : { 'task-detail': { width: 900, height } };
    wrapper = mount(BackgroundTaskDetailModal, { props: { open: true, task: agent, conversationId: 'c1' }, attachTo: document.body });
    await flushPromises();
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    const transcript = document.querySelector<HTMLElement>('.agent-transcript')!.getBoundingClientRect().height;
    const scrolls = dialogScrolls();
    wrapper.unmount();
    wrapper = null;
    return { transcript, scrolls };
  }

  it('grows and shrinks with the dialog, the dialog itself not scrolling', async () => {
    const taller = await openedAt(780);
    const shorter = await openedAt(480);

    expect(taller.transcript).toBeGreaterThan(shorter.transcript + 200);
    expect(taller.scrolls).toBe(false);
    expect(shorter.scrolls).toBe(false);
  });

  it('sized to its content, is the 60% of the window it was', async () => {
    const { transcript } = await openedAt(null);

    expect(Math.abs(transcript - 0.6 * window.innerHeight)).toBeLessThanOrEqual(2);
  });
});
