/**
 * A sidebar's edge, dragged to change its width: the width follows the
 * pointer within bounds, and is reported for saving once, when the drag ends.
 */

import { mount } from '@vue/test-utils';
import { describe, it, expect, afterEach } from 'vitest';

import { RESIZE_KEY_STEP, SIDEBAR_WIDTH } from '../../../constants/layout';
import SidebarResizeHandle from '../SidebarResizeHandle.vue';

const mounted: Array<{ unmount: () => void }> = [];

function mountHandle(width = 280) {
  const wrapper = mount(SidebarResizeHandle, {
    props: { width, defaultWidth: 280, label: 'files' },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

function pointer(type: string, clientX: number, pointerId = 1): PointerEvent {
  return new PointerEvent(type, { clientX, clientY: 0, pointerId, button: 0, bubbles: true });
}

afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount());
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

describe('SidebarResizeHandle', () => {
  it('follows the pointer while dragging and reports the width once, at the end', () => {
    const wrapper = mountHandle(280);
    const handle = wrapper.element as HTMLElement;

    handle.dispatchEvent(pointer('pointerdown', 500));
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');
    handle.dispatchEvent(pointer('pointermove', 540));
    handle.dispatchEvent(pointer('pointermove', 600));
    expect(wrapper.emitted('update:width')).toEqual([[320], [380]]);
    expect(wrapper.emitted('commit')).toBeUndefined();

    handle.dispatchEvent(pointer('pointerup', 600));
    expect(wrapper.emitted('commit')).toEqual([[380]]);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    // Over: moving afterwards changes nothing.
    handle.dispatchEvent(pointer('pointermove', 700));
    expect(wrapper.emitted('update:width')).toHaveLength(2);
  });

  it('keeps the width within its bounds', () => {
    const wrapper = mountHandle(280);
    const handle = wrapper.element as HTMLElement;
    handle.dispatchEvent(pointer('pointerdown', 500));
    handle.dispatchEvent(pointer('pointermove', 2000));
    handle.dispatchEvent(pointer('pointermove', -2000));
    handle.dispatchEvent(pointer('pointerup', -2000));
    expect(wrapper.emitted('update:width')).toEqual([[SIDEBAR_WIDTH.MAX], [SIDEBAR_WIDTH.MIN]]);
    expect(wrapper.emitted('commit')).toEqual([[SIDEBAR_WIDTH.MIN]]);
  });

  it('starts from the width the sidebar is drawn at, when the window has made it give way', () => {
    const wrapper = mountHandle(600);
    const handle = wrapper.element as HTMLElement;
    handle.parentElement!.getBoundingClientRect = () => ({ width: 520 }) as DOMRect;
    handle.dispatchEvent(pointer('pointerdown', 500));
    handle.dispatchEvent(pointer('pointermove', 470));
    handle.dispatchEvent(pointer('pointerup', 470));
    expect(wrapper.emitted('commit')).toEqual([[490]]);
  });

  it('saves nothing for a click that did not move it', () => {
    const wrapper = mountHandle(280);
    const handle = wrapper.element as HTMLElement;
    handle.dispatchEvent(pointer('pointerdown', 500));
    handle.dispatchEvent(pointer('pointerup', 500));
    expect(wrapper.emitted('commit')).toBeUndefined();
  });

  it('ends the drag when the pointer is cancelled', () => {
    const wrapper = mountHandle(280);
    const handle = wrapper.element as HTMLElement;
    handle.dispatchEvent(pointer('pointerdown', 500));
    handle.dispatchEvent(pointer('pointermove', 520));
    handle.dispatchEvent(pointer('pointercancel', 520));
    expect(wrapper.emitted('commit')).toEqual([[300]]);
    expect(document.body.style.cursor).toBe('');
  });

  it('moves by a step with the arrow keys, and to the bounds with Home and End', async () => {
    const wrapper = mountHandle(280);
    await wrapper.trigger('keydown', { key: 'ArrowRight' });
    await wrapper.trigger('keydown', { key: 'ArrowLeft' });
    await wrapper.trigger('keydown', { key: 'End' });
    await wrapper.trigger('keydown', { key: 'Home' });
    expect(wrapper.emitted('commit')).toEqual([
      [280 + RESIZE_KEY_STEP],
      [280 - RESIZE_KEY_STEP],
      [SIDEBAR_WIDTH.MAX],
      [SIDEBAR_WIDTH.MIN],
    ]);
  });

  it('goes back to its default width on a double-click', async () => {
    const wrapper = mountHandle(450);
    await wrapper.trigger('dblclick');
    expect(wrapper.emitted('commit')).toEqual([[280]]);
  });

  it('says what it resizes, and how wide it is, to screen readers', () => {
    const wrapper = mountHandle(300);
    expect(wrapper.attributes('role')).toBe('separator');
    expect(wrapper.attributes('aria-label')).toBe('Resize files');
    expect(wrapper.attributes('aria-valuenow')).toBe('300');
  });
});
