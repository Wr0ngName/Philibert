/**
 * The context menu's size and place, in a real browser with the app's own
 * styles: happy-dom lays nothing out, so it cannot see a menu's width.
 *
 * Seen in the file panel's five-item menu: it opened 690 px wide, far left
 * of the click. Its items were inline-blocks — a button's own display — so
 * the menu's natural width added them up side by side.
 *
 * Run with `npm run test:browser`.
 */

import '../../../assets/styles/main.css';

import { mount } from '@vue/test-utils';
import { describe, it, expect, afterEach } from 'vitest';

import ContextMenu from '../ContextMenu.vue';

const ITEMS = ['Open with default app', 'Show in file manager', 'Show changes', 'Copy path', 'Copy relative path']
  .map((label) => ({ label, onSelect: () => undefined }));

let wrapper: ReturnType<typeof mount> | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

async function openAt(x: number, y: number): Promise<HTMLElement> {
  // Mounted closed and then opened, as every component using it does: it
  // places itself when it opens.
  wrapper = mount(ContextMenu, { props: { open: false, x: 0, y: 0, items: ITEMS }, attachTo: document.body });
  await wrapper.setProps({ open: true, x, y });
  // It measures itself after rendering, to stay inside the window.
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  if (!menu) throw new Error('the menu did not open');
  return menu;
}

describe('the context menu', () => {
  it('is as wide as its longest item, its items one under the other', async () => {
    const menu = await openAt(20, 20);
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const widest = Math.max(...items.map((item) => {
      const range = document.createRange();
      range.selectNodeContents(item);
      return range.getBoundingClientRect().width;
    }));

    expect(menu.getBoundingClientRect().width).toBeLessThan(widest + 60);
    const tops = items.map((item) => item.getBoundingClientRect().top);
    expect(new Set(tops).size).toBe(items.length);
  });

  it('opens at the click, when it fits there', async () => {
    const menu = await openAt(100, 50);
    const rect = menu.getBoundingClientRect();

    expect(Math.round(rect.left)).toBe(100);
    expect(Math.round(rect.top)).toBe(50);
  });

  it('opens just inside the window when the click is near its edge', async () => {
    const menu = await openAt(window.innerWidth - 20, 50);
    const rect = menu.getBoundingClientRect();

    expect(rect.right).toBeLessThanOrEqual(window.innerWidth - 8 + 0.5);
    expect(rect.left).toBeGreaterThan(window.innerWidth - 300);
  });
});
