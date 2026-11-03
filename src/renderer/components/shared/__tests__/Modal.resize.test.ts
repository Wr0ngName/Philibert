/**
 * A resizable dialog: dragged from its corner grip, it keeps the size it was
 * given, within the window, and opens at it next time — the size is saved in
 * the config by the dialog's key.
 *
 * `window.electron` is the process boundary, so it is what is mocked; the
 * settings store runs for real.
 */

import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { MODAL_SIZE, RESIZE_KEY_STEP } from '../../../constants/layout';
import { useSettingsStore } from '../../../stores/settings';
import Modal from '../Modal.vue';

const configApi = { set: vi.fn() };
const mounted: Array<{ unmount: () => void }> = [];

function mountModal(resizeKey?: string) {
  const wrapper = mount(Modal, {
    props: { open: true, title: 'Details', ...(resizeKey ? { resizeKey } : {}) },
    slots: { default: '<p>Body</p>' },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

function box(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[role="dialog"] [tabindex="-1"]');
  if (!element) throw new Error('no dialog box');
  return element;
}

function grip(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.modal-resize-grip');
}

/** happy-dom lays nothing out: give the box the size a browser would. */
function measure(width: number, height: number): void {
  Object.defineProperty(box(), 'offsetWidth', { configurable: true, value: width });
  Object.defineProperty(box(), 'offsetHeight', { configurable: true, value: height });
}

function pointer(type: string, clientX: number, clientY: number): PointerEvent {
  return new PointerEvent(type, { clientX, clientY, pointerId: 1, button: 0, bubbles: true });
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  // As IPC does: what cannot be structured-cloned, such as a reactive proxy,
  // is refused.
  configApi.set.mockImplementation(async (updates: unknown) => {
    structuredClone(updates);
  });
  (window as unknown as { electron: unknown }).electron = { config: configApi };
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
});

afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount());
});

describe('Modal resizing', () => {
  it('offers no grip, and needs no store, unless it is given a key', async () => {
    setActivePinia(undefined);
    mountModal();
    await flushPromises();
    expect(grip()).toBeNull();
    expect(box().style.width).toBe('');
  });

  it('opens at its preset size until it is resized', async () => {
    mountModal('tool-detail');
    await flushPromises();
    expect(grip()).not.toBeNull();
    expect(box().style.width).toBe('');
    expect(box().classList.contains('max-w-md')).toBe(true);
  });

  it('follows the grip, twice the pointer move as it stays centred, and saves the size once', async () => {
    mountModal('tool-detail');
    await flushPromises();
    measure(768, 500);

    grip()!.dispatchEvent(pointer('pointerdown', 1000, 700));
    grip()!.dispatchEvent(pointer('pointermove', 1050, 720));
    await flushPromises();
    expect(box().style.width).toBe('868px');
    expect(box().style.height).toBe('540px');
    expect(box().style.maxWidth).toBe('none');
    expect(configApi.set).not.toHaveBeenCalled();

    grip()!.dispatchEvent(pointer('pointerup', 1050, 720));
    await flushPromises();
    expect(configApi.set).toHaveBeenCalledTimes(1);
    expect(configApi.set).toHaveBeenCalledWith({ modalSizes: { 'tool-detail': { width: 868, height: 540 } } });
    expect(box().style.width).toBe('868px');
  });

  it('opens at the size it was saved with, kept within the window', async () => {
    useSettingsStore().config.modalSizes = {
      'tool-detail': { width: 900, height: 600 },
      'task-detail': { width: 5000, height: 50 },
    };
    mountModal('tool-detail');
    await flushPromises();
    expect(box().style.width).toBe('900px');
    expect(box().style.height).toBe('600px');
    mounted.splice(0).forEach((w) => w.unmount());

    mountModal('task-detail');
    await flushPromises();
    expect(box().style.width).toBe(`${1600 - 2 * MODAL_SIZE.VIEWPORT_MARGIN}px`);
    expect(box().style.height).toBe(`${MODAL_SIZE.MIN_HEIGHT}px`);
  });

  it('grows by a step with the arrow keys on the grip', async () => {
    mountModal('rewind');
    await flushPromises();
    measure(672, 400);
    grip()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flushPromises();
    expect(configApi.set).toHaveBeenCalledWith({
      modalSizes: { rewind: { width: 672 + RESIZE_KEY_STEP, height: 400 } },
    });
  });

  it('goes back to its preset size on a double-click of the grip, forgetting only its own', async () => {
    useSettingsStore().config.modalSizes = {
      'tool-detail': { width: 900, height: 600 },
      search: { width: 700, height: 500 },
    };
    mountModal('tool-detail');
    await flushPromises();
    grip()!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flushPromises();
    expect(configApi.set).toHaveBeenCalledWith({ modalSizes: { search: { width: 700, height: 500 } } });
    expect(box().style.width).toBe('');
  });
});
