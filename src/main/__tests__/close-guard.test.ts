/**
 * Warning before quitting with work in flight, and persisting on the way out.
 *
 * Two things are worth testing without a real Electron window: whether to warn
 * at all — warning when nothing is running would put a dialog in front of
 * every ordinary close, and staying silent when something is runs loses a turn
 * mid-answer — and that the close is actually HELD while the renderer saves.
 * The renderer's own save hangs off `onUnmounted`, which nothing waits for, so
 * "it saves on close" was a hope rather than a guarantee.
 */

import { ipcMain } from 'electron';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { IPC_CHANNELS } from '../../shared/types';
import { describeRunningWork, installCloseGuard, requestRendererFlush } from '../window';

const { showMessageBox } = vi.hoisted(() => ({ showMessageBox: vi.fn() }));

/**
 * `ipcMain` is an EventEmitter, so the stand-in is a real one.
 *
 * The first version hand-rolled `once`/`removeListener` over a Map, and then
 * had to grow Node's `wrapped.listener` tagging to stop reporting a listener
 * leak the real module does not have. Reimplementing a library inside a fake
 * is how a fake drifts from what it stands for; using the library removes the
 * question. Built inside the factory because `vi.mock` is hoisted above any
 * top-level value it could otherwise capture — and hoisted above the imports
 * too, which is why importing `ipcMain` above still yields this instance.
 */
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    BrowserWindow: class {},
    Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
    dialog: { showMessageBox },
    ipcMain: new EventEmitter(),
    shell: { openExternal: vi.fn() },
  };
});

vi.mock('../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogLevel: vi.fn(),
}));

/** The mocked ipcMain, which is a real EventEmitter. */
const ipc = ipcMain;

/** Stands in for the window: records sends, closes and prevented events. */
function fakeWindow() {
  const sent: string[] = [];
  let closeHandler: ((event: { preventDefault: () => void }) => void) | null = null;
  const state = { closes: 0, prevented: 0, destroyed: false };

  const win = {
    on(event: string, handler: (e: { preventDefault: () => void }) => void) {
      if (event === 'close') closeHandler = handler;
    },
    close() {
      state.closes += 1;
      // Electron emits `close` again, which is what the latch is for.
      closeHandler?.({ preventDefault: () => { state.prevented += 1; } });
    },
    isDestroyed: () => state.destroyed,
    webContents: {
      isDestroyed: () => state.destroyed,
      send: (channel: string) => { sent.push(channel); },
    },
  };

  return {
    win,
    sent,
    state,
    fireClose: () => closeHandler?.({ preventDefault: () => { state.prevented += 1; } }),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  ipc.removeAllListeners();
  showMessageBox.mockReset();
});

describe('describeRunningWork', () => {
  it('says nothing when nothing is running', () => {
    // The ordinary close must stay a single click.
    expect(describeRunningWork({ turns: 0, tasks: 0 })).toBeNull();
  });

  it('reports a single conversation mid-turn', () => {
    expect(describeRunningWork({ turns: 1, tasks: 0 })).toBe('1 conversation still working');
  });

  it('pluralises conversations', () => {
    expect(describeRunningWork({ turns: 3, tasks: 0 })).toBe('3 conversations still working');
  });

  it('reports background tasks on their own', () => {
    // A turn can finish while its tasks keep running, which is the deliberate
    // behaviour of Stop — so this is a real case, not a corner.
    expect(describeRunningWork({ turns: 0, tasks: 1 })).toBe('1 background task still running');
    expect(describeRunningWork({ turns: 0, tasks: 2 })).toBe('2 background tasks still running');
  });

  it('reports both when both are in flight', () => {
    expect(describeRunningWork({ turns: 2, tasks: 1 })).toBe(
      '2 conversations still working and 1 background task still running',
    );
  });
});

describe('requestRendererFlush', () => {
  it('asks the renderer and waits for its answer', async () => {
    const { win, sent } = fakeWindow();

    let settled = false;
    const flush = requestRendererFlush(win as never, 10_000).then(() => { settled = true; });
    await settle();

    expect(sent).toEqual([IPC_CHANNELS.WINDOW_FLUSH_BEFORE_CLOSE]);
    expect(settled).toBe(false);

    ipc.emit(IPC_CHANNELS.WINDOW_FLUSH_COMPLETE);
    await flush;
    expect(settled).toBe(true);
  });

  it('gives up rather than leaving a window that cannot close', async () => {
    // A renderer that never answers — a crash, a breakpoint, a save wedged on
    // a slow disk. Giving up loses at most what that save would have written,
    // which is the situation before any of this existed.
    const { win } = fakeWindow();
    await requestRendererFlush(win as never, 1);
  });

  it('leaves no listener behind either way', async () => {
    const { win } = fakeWindow();

    const answered = requestRendererFlush(win as never, 10_000);
    await settle();
    ipc.emit(IPC_CHANNELS.WINDOW_FLUSH_COMPLETE);
    await answered;
    expect(ipc.listenerCount(IPC_CHANNELS.WINDOW_FLUSH_COMPLETE)).toBe(0);

    await requestRendererFlush(win as never, 1);
    expect(ipc.listenerCount(IPC_CHANNELS.WINDOW_FLUSH_COMPLETE)).toBe(0);
  });

  it('asks nothing of a window that is already gone', async () => {
    const { win, sent, state } = fakeWindow();
    state.destroyed = true;

    await requestRendererFlush(win as never, 10_000);

    expect(sent).toEqual([]);
  });
});

describe('installCloseGuard', () => {
  it('holds the close until the save finishes, with nothing running', async () => {
    // No dialog — there is nothing to warn about — but the close still waits
    // for the renderer, which is the half that was missing entirely.
    const { win, state, fireClose } = fakeWindow();
    let flushed = false;
    let releaseFlush: (() => void) | undefined;
    const flush = () => new Promise<void>((resolve) => {
      releaseFlush = () => { flushed = true; resolve(); };
    });

    installCloseGuard(win as never, () => ({ turns: 0, tasks: 0 }), flush);

    fireClose();
    await settle();

    expect(state.prevented).toBe(1);
    expect(state.closes).toBe(0);
    expect(showMessageBox).not.toHaveBeenCalled();

    releaseFlush!();
    await settle();

    expect(flushed).toBe(true);
    expect(state.closes).toBe(1);
  });

  it('asks first when work is running, and saves only once allowed', async () => {
    const { win, state, fireClose } = fakeWindow();
    const flush = vi.fn(async () => {});
    showMessageBox.mockResolvedValue({ response: 1 }); // Quit anyway

    installCloseGuard(win as never, () => ({ turns: 1, tasks: 2 }), flush);

    fireClose();
    await settle();
    await settle();

    expect(showMessageBox).toHaveBeenCalledTimes(1);
    const detail = showMessageBox.mock.calls[0][1].detail as string;
    expect(detail).toContain('1 conversation still working');
    expect(detail).toContain('2 background tasks still running');
    expect(flush).toHaveBeenCalledTimes(1);
    expect(state.closes).toBe(1);
  });

  it('neither saves nor closes when the user keeps working', async () => {
    const { win, state, fireClose } = fakeWindow();
    const flush = vi.fn(async () => {});
    showMessageBox.mockResolvedValue({ response: 0 }); // Keep working

    installCloseGuard(win as never, () => ({ turns: 1, tasks: 0 }), flush);

    fireClose();
    await settle();
    await settle();

    expect(flush).not.toHaveBeenCalled();
    expect(state.closes).toBe(0);
  });

  it('closes anyway when saving fails', async () => {
    // A renderer that cannot save must not become a window that cannot close.
    const { win, state, fireClose } = fakeWindow();
    const flush = vi.fn(async () => {
      throw new Error('disk full');
    });

    installCloseGuard(win as never, () => ({ turns: 0, tasks: 0 }), flush);

    fireClose();
    await settle();
    await settle();

    expect(state.closes).toBe(1);
  });

  it('does not ask twice, or save twice, for one close', async () => {
    // `close` is emitted again by the close that follows confirmation; without
    // the latch the dialog would reappear forever.
    const { win, state, fireClose } = fakeWindow();
    const flush = vi.fn(async () => {});
    showMessageBox.mockResolvedValue({ response: 1 });

    installCloseGuard(win as never, () => ({ turns: 1, tasks: 0 }), flush);

    fireClose();
    await settle();
    await settle();

    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(state.closes).toBe(1);
  });

  it('still closes when the running-work check itself throws', async () => {
    const { win, state, fireClose } = fakeWindow();
    const flush = vi.fn(async () => {});

    installCloseGuard(
      win as never,
      () => {
        throw new Error('cannot tell');
      },
      flush,
    );

    fireClose();
    await settle();
    await settle();

    expect(showMessageBox).not.toHaveBeenCalled();
    // And it still saves on the way out.
    expect(flush).toHaveBeenCalledTimes(1);
    expect(state.closes).toBe(1);
  });
});
