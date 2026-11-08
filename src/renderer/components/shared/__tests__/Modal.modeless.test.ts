/**
 * A modeless, movable dialog: the window behind it stays usable — nothing
 * dims it or takes its pointer, its page scroll is not locked, and Escape
 * typed there is not the dialog's — and the dialog moves with its title bar,
 * kept within the window.
 */

import { mount, flushPromises } from '@vue/test-utils';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';

import { MODAL_SIZE } from '../../../constants/layout';
import Modal from '../Modal.vue';

const mounted: Array<{ unmount: () => void }> = [];

function mountModal(props: Record<string, unknown> = {}) {
  const wrapper = mount(Modal, {
    props: { open: true, title: 'Question', ...props },
    slots: { default: '<input class="inside" />' },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

function container(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!element) throw new Error('no dialog');
  return element;
}

function box(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[role="dialog"] [tabindex="-1"]');
  if (!element) throw new Error('no dialog box');
  return element;
}

function titleBar(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.modal-title-bar');
  if (!element) throw new Error('no title bar');
  return element;
}

/** happy-dom lays nothing out: give the box the size a browser would. */
function measure(width: number, height: number): void {
  Object.defineProperty(box(), 'offsetWidth', { configurable: true, value: width });
  Object.defineProperty(box(), 'offsetHeight', { configurable: true, value: height });
}

function pointer(target: HTMLElement, type: string, clientX: number, clientY: number): void {
  target.dispatchEvent(new PointerEvent(type, { clientX, clientY, pointerId: 1, button: 0, bubbles: true }));
}

async function drag(target: HTMLElement, dx: number, dy: number): Promise<void> {
  pointer(target, 'pointerdown', 500, 300);
  pointer(target, 'pointermove', 500 + dx, 300 + dy);
  pointer(target, 'pointerup', 500 + dx, 300 + dy);
  await flushPromises();
}

function escapeFrom(target: EventTarget): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
  document.body.style.overflow = '';
});

afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount());
  document.body.innerHTML = '';
});

describe('a modeless dialog', () => {
  it('neither dims the window behind it nor takes its pointer or its scrolling', async () => {
    mountModal({ modeless: true });
    await flushPromises();

    expect(document.querySelector('.bg-black\\/50')).toBeNull();
    expect(container().classList.contains('pointer-events-none')).toBe(true);
    expect(box().classList.contains('pointer-events-auto')).toBe(true);
    expect(document.body.style.overflow).toBe('');
    expect(container().getAttribute('aria-modal')).toBe('false');
  });

  it('closes on Escape from inside it, and not on Escape typed elsewhere', async () => {
    const wrapper = mountModal({ modeless: true });
    await flushPromises();
    const elsewhere = document.createElement('textarea');
    document.body.appendChild(elsewhere);

    escapeFrom(elsewhere);
    expect(wrapper.emitted('close')).toBeUndefined();

    escapeFrom(document.querySelector('.inside')!);
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('is not what a modal dialog is: that one still dims, locks and closes on any Escape', async () => {
    const wrapper = mountModal();
    await flushPromises();

    expect(document.querySelector('.bg-black\\/50')).not.toBeNull();
    expect(document.body.style.overflow).toBe('hidden');
    escapeFrom(document.body);
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});

describe('a movable dialog', () => {
  it('follows its title bar', async () => {
    mountModal({ movable: true });
    await flushPromises();
    measure(600, 400);

    await drag(titleBar(), 120, -80);

    expect(box().style.transform).toBe('translate(120px, -80px)');
  });

  it('stays within the window, however far it is dragged', async () => {
    mountModal({ movable: true });
    await flushPromises();
    measure(600, 400);

    await drag(titleBar(), 5000, 5000);

    // Centred, it has (1600 - 600) / 2 to its sides and (1000 - 400) / 2
    // above and below, less the margin kept from the edge.
    const roomX = 500 - MODAL_SIZE.VIEWPORT_MARGIN;
    const roomY = 300 - MODAL_SIZE.VIEWPORT_MARGIN;
    expect(box().style.transform).toBe(`translate(${roomX}px, ${roomY}px)`);
  });

  it('is not moved by pressing its close button', async () => {
    const wrapper = mountModal({ movable: true });
    await flushPromises();
    measure(600, 400);
    const close = document.querySelector<HTMLElement>('[aria-label="Close"]')!;

    await drag(close, 120, 80);
    close.click();

    expect(box().style.transform).toBe('');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('opens in the middle again', async () => {
    const wrapper = mountModal({ movable: true });
    await flushPromises();
    measure(600, 400);
    await drag(titleBar(), 120, 80);
    expect(box().style.transform).not.toBe('');

    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    await flushPromises();

    expect(box().style.transform).toBe('');
  });

  it('does not move unless it is movable', async () => {
    mountModal();
    await flushPromises();
    measure(600, 400);

    await drag(titleBar(), 120, 80);

    expect(box().style.transform).toBe('');
  });
});
