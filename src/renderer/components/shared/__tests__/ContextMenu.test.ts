/**
 * Where ContextMenu opens. The Stop button's caret points up, and its menu
 * used to open downward from the button's top edge — over the button itself.
 */

import { flushPromises, mount } from '@vue/test-utils';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import ContextMenu from '../ContextMenu.vue';

const MENU_HEIGHT = 72;
const MENU_WIDTH = 200;
const VIEWPORT = { width: 1400, height: 900 };

const realHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
const realWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');

beforeEach(() => {
  // No layout here, so the menu is given the size a browser would.
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) { return this.getAttribute('role') === 'menu' ? MENU_HEIGHT : 0; },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) { return this.getAttribute('role') === 'menu' ? MENU_WIDTH : 0; },
  });
  Object.assign(window, { innerWidth: VIEWPORT.width, innerHeight: VIEWPORT.height });
});

afterEach(() => {
  if (realHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', realHeight);
  if (realWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', realWidth);
  document.body.innerHTML = '';
});

async function openAt(y: number, above: boolean): Promise<{ top: number }> {
  const wrapper = mount(ContextMenu, {
    props: { open: false, x: 500, y, items: [{ label: 'Stop this turn only', onSelect: () => {} }], above },
    attachTo: document.body,
  });
  await wrapper.setProps({ open: true });
  await flushPromises();
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  if (!menu) throw new Error('menu did not open');
  const top = parseFloat(menu.style.top);
  wrapper.unmount();
  return { top };
}

describe('ContextMenu placement', () => {
  it('opens above its anchor when asked: its bottom edge just over it', async () => {
    const { top } = await openAt(800, true);

    expect(top + MENU_HEIGHT).toBeLessThanOrEqual(800);
    expect(top).toBe(800 - MENU_HEIGHT - 4);
  });

  it('opens below its anchor otherwise, as a right-click menu does', async () => {
    const { top } = await openAt(300, false);

    expect(top).toBe(300);
  });

  it('stays inside the window when there is no room above', async () => {
    const { top } = await openAt(40, true);

    expect(top).toBe(8);
  });
});
