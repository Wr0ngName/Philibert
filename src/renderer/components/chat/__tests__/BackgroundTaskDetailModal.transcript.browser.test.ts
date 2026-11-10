/**
 * An agent's long transcript opened in its view, with real layout.
 *
 * Reported: opening a long transcript took seconds. Measured in the app on
 * one of 1,048 messages: the view mounted its list together with the
 * transcript, so the list had no size yet on its first render — and the
 * virtual list renders every row when it does not know its size. All their
 * markdown was rendered (0.9 s), then all of them measured and dropped
 * (0.5 s), for 9 rows on screen. The discussion's own list never did: it is
 * mounted and laid out before its messages arrive. The view now does the
 * same.
 */

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { BackgroundTask, ChatMessage } from '@shared/types';

import BackgroundTaskDetailModal from '../BackgroundTaskDetailModal.vue';

const COUNT = 400;
const PARAGRAPH = 'This answer runs on for several lines so that it wraps. ';

function transcript(): ChatMessage[] {
  return Array.from({ length: COUNT }, (_unused, index) => ({
    id: `t-${index}`,
    role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `Message ${index}. ${PARAGRAPH.repeat(index % 5)}`,
    timestamp: index,
  }));
}

const TASK: BackgroundTask = {
  id: 'agent-1', description: 'Long research', status: 'completed', startedAt: 1, completedAt: 2,
  taskType: 'agent', toolUseId: 'toolu_agent',
};

let release: () => void = () => {};

beforeEach(() => {
  setActivePinia(createPinia());
  // The transcript arrives when the test says, as it does from the main
  // process a moment after the view opens.
  const arrived = new Promise<void>((resolve) => { release = resolve; });
  (window as unknown as { electron: unknown }).electron = {
    claude: {
      getAgentTranscript: async () => {
        await arrived;
        return transcript();
      },
      readTaskOutput: async () => ({ text: '', nextByte: 0, skippedBytes: 0 }),
    },
  };
});

afterEach(() => {
  document.body.innerHTML = '';
});

async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
}

/**
 * Give the view's list the layout the app's stylesheet gives it — these tests
 * run without Tailwind, as MessageList.scroll.browser.test.ts does: a list
 * 600px tall, scrolling inside. Applied as soon as the list exists.
 */
function layOut(): void {
  const area = document.body.querySelector<HTMLElement>('.agent-transcript');
  if (!area) return;
  area.style.position = 'relative';
  area.style.height = '600px';
  area.style.width = '800px';
  const root = area.firstElementChild as HTMLElement | null;
  if (root) Object.assign(root.style, { position: 'relative', height: '600px', width: '800px' });
  const list = area.querySelector<HTMLElement>('.overflow-y-auto');
  if (list) Object.assign(list.style, { position: 'absolute', top: '0', left: '0', right: '0', bottom: '0', overflowY: 'auto' });
}

describe("an agent's transcript in its view", () => {
  it('renders the rows in view when the transcript arrives, not all of them', async () => {
    const wrapper = mount(BackgroundTaskDetailModal, {
      props: { open: true, task: TASK, conversationId: 'conv-1' },
      attachTo: document.body,
    });
    await frames(2);
    layOut();
    await frames(5);
    // The list is there, laid out, before the transcript arrives.
    expect(document.body.querySelector('.agent-transcript .overflow-y-auto')?.clientHeight).toBe(600);

    // The most rows ever in the list from now on: rendering them all and
    // trimming them back once measured ends on few rows too — the cost is
    // the peak, so the peak is what is checked.
    let most = 0;
    const count = () => {
      most = Math.max(most, document.body.querySelectorAll('.agent-transcript .chat-row').length);
    };
    const observer = new MutationObserver(count);
    observer.observe(document.body, { childList: true, subtree: true });

    release();
    await frames(2);
    layOut();
    await frames(30);
    observer.disconnect();
    count();

    expect(document.body.querySelectorAll('.agent-transcript .chat-row').length).toBeGreaterThan(0);
    // Virtualised from the first render: a screenful and its overscan.
    expect(most).toBeLessThan(60);
    wrapper.unmount();
  });

  it('says it is loading while the transcript is read, not that there is nothing', async () => {
    const wrapper = mount(BackgroundTaskDetailModal, {
      props: { open: true, task: TASK, conversationId: 'conv-1' },
      attachTo: document.body,
    });
    await frames(5);

    expect(document.body.querySelector('.agent-transcript')?.textContent).not.toContain('Nothing yet');
    release();
    await frames(30);
    expect(document.body.querySelectorAll('.agent-transcript .chat-row').length).toBeGreaterThan(0);
    wrapper.unmount();
  });
});
