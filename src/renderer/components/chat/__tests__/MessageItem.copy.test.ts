/**
 * Copying a message, or the part of it the user highlighted.
 *
 * Reported as "copy selection does nothing". The path has several places it
 * could break silently — the menu item might not reach its handler, the
 * selection might not be attributable to the message, or the clipboard write
 * might fail — and `copyContent` swallows every error from the last of those,
 * so any of them looks identical from the outside. These tests separate them.
 */

import { mount } from '@vue/test-utils';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';

import type { ChatMessage } from '@shared/types';

import MessageItem from '../MessageItem.vue';

/** Error lines the component logged, so a silent failure can be ruled out. */
const logged: string[] = [];
vi.mock('../../../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (message: string) => {
      logged.push(message);
    },
  },
}));

const ASSISTANT: ChatMessage = {
  id: 'msg-1',
  role: 'assistant',
  content: 'The quick brown fox jumps over the lazy dog.',
  timestamp: 1,
};

let wrapper: ReturnType<typeof mount> | null = null;

/** Menu items live in a Teleport to body, so they are not inside the wrapper. */
function menuItems(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
}

function itemLabelled(text: string): HTMLButtonElement | undefined {
  return menuItems().find((item) => (item.textContent ?? '').includes(text));
}

/** Select the whole of an element's text, as a user dragging across it would. */
function selectContentsOf(element: Element): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

async function openMenuOn(element: Element): Promise<void> {
  element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
  await nextTick();
  await nextTick();
}

describe('copying from a message', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    logged.length = 0;
    window.getSelection()?.removeAllRanges();

    writeText = vi.fn().mockResolvedValue(undefined);
    // The OS clipboard is the one genuinely external thing here; everything
    // between the click and it is real, including the preload-shaped bridge
    // the component actually calls.
    (globalThis as unknown as { window: Record<string, unknown> }).window.electron = {
      clipboard: { writeText },
    };
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  function mountMessage() {
    wrapper = mount(MessageItem, {
      props: { message: ASSISTANT },
      attachTo: document.body,
    });
    return wrapper;
  }

  it('offers to copy the whole message when nothing is selected', async () => {
    const w = mountMessage();
    await openMenuOn(w.find('.message-content').element);

    expect(itemLabelled('Copy message')).toBeDefined();
    expect(itemLabelled('Copy selection')).toBeUndefined();
  });

  it('copies the whole message', async () => {
    const w = mountMessage();
    await openMenuOn(w.find('.message-content').element);

    itemLabelled('Copy message')!.click();
    await nextTick();

    expect(writeText).toHaveBeenCalledWith(ASSISTANT.content);
  });

  it('offers to copy the selection when text in this message is highlighted', async () => {
    const w = mountMessage();
    const content = w.find('.message-content').element;
    selectContentsOf(content);

    await openMenuOn(content);

    expect(itemLabelled('Copy selection')).toBeDefined();
  });

  it('copies what was highlighted, not the whole message', async () => {
    // The point of the feature: highlighting one line of a long reply and
    // hitting Copy used to paste the entire reply.
    const w = mountMessage();
    const content = w.find('.message-content').element;
    selectContentsOf(content);

    await openMenuOn(content);
    const item = itemLabelled('Copy selection');
    expect(item).toBeDefined();

    item!.click();
    await nextTick();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toBe(window.getSelection()?.toString());
  });

  it('copies through the main process, not the web clipboard API', async () => {
    // `navigator.clipboard` is subject to Chromium's permission and focus
    // gates, and this app's window denies every permission except media — so
    // a refused write is indistinguishable from a menu item that does
    // nothing, which is how this was reported. Asserted so a well-meaning
    // simplification back to the web API shows up here.
    const webWrite = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: webWrite },
      configurable: true,
      writable: true,
    });

    const w = mountMessage();
    await openMenuOn(w.find('.message-content').element);
    itemLabelled('Copy message')!.click();
    await nextTick();

    expect(writeText).toHaveBeenCalledWith(ASSISTANT.content);
    expect(webWrite).not.toHaveBeenCalled();
  });

  it('does not fail silently when the copy is refused', async () => {
    // Discarding the error is what made the failure invisible.
    const w = mountMessage();
    writeText.mockRejectedValue(new Error('clipboard unavailable'));

    await openMenuOn(w.find('.message-content').element);
    itemLabelled('Copy message')!.click();
    await nextTick();
    await nextTick();

    expect(logged).toContainEqual(
      expect.stringContaining('Failed to copy to the clipboard'),
    );
  });
});
