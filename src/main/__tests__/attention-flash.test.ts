/**
 * The window flashes in the taskbar while a permission ask or a question
 * waits on the user and they are elsewhere — and only then: a window being
 * looked at needs no flashing, and one with nothing waiting has nothing to
 * say.
 */

import { EventEmitter } from 'node:events';

import type { BrowserWindow } from 'electron';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { installAttentionFlash, setAttentionNeeded } from '../window';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: { once: vi.fn(), on: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

vi.mock('../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogLevel: vi.fn(),
}));

/** Stands in for the window: focus is set by the test, and focus events are real ones. */
function fakeWindow() {
  const emitter = new EventEmitter();
  const state = { focused: true, destroyed: false, flashing: false };
  const flashFrame = vi.fn((flag: boolean) => { state.flashing = flag; });
  const win = Object.assign(emitter, {
    isFocused: () => state.focused,
    isDestroyed: () => state.destroyed,
    flashFrame,
  });
  installAttentionFlash(win as unknown as BrowserWindow);
  return {
    win: win as unknown as BrowserWindow,
    state,
    flashFrame,
    focus() { state.focused = true; emitter.emit('focus'); },
    blur() { state.focused = false; emitter.emit('blur'); },
  };
}

beforeEach(() => {
  setAttentionNeeded(false, null);
});

describe('the attention flash', () => {
  it('flashes when something starts to wait while the user is elsewhere', () => {
    const w = fakeWindow();
    w.blur();

    setAttentionNeeded(true, w.win);

    expect(w.state.flashing).toBe(true);
  });

  it('does not flash a window the user is looking at', () => {
    const w = fakeWindow();

    setAttentionNeeded(true, w.win);

    expect(w.state.flashing).toBe(false);
  });

  it('starts when the user leaves with something still waiting, and stops when they come back', () => {
    const w = fakeWindow();
    setAttentionNeeded(true, w.win);

    w.blur();
    expect(w.state.flashing).toBe(true);

    w.focus();
    expect(w.state.flashing).toBe(false);
  });

  it('stops once nothing waits any more, though the user has not come back', () => {
    const w = fakeWindow();
    w.blur();
    setAttentionNeeded(true, w.win);

    setAttentionNeeded(false, w.win);

    expect(w.state.flashing).toBe(false);
  });

  it('does not flash when the user leaves with nothing waiting', () => {
    const w = fakeWindow();

    w.blur();

    expect(w.state.flashing).toBe(false);
  });

  it('leaves a destroyed window alone', () => {
    const w = fakeWindow();
    w.state.destroyed = true;
    w.state.focused = false;

    setAttentionNeeded(true, w.win);

    expect(w.flashFrame).not.toHaveBeenCalled();
  });
});
