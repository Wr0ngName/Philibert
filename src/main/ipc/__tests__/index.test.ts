/**
 * Tearing the IPC surface down removes everything that set it up.
 *
 * The cleanup works from a hand-kept list of channels, separate from the
 * registrations themselves, and the two drifted apart: seventeen handlers had
 * been added over time without ever being added to the list, so cleanup left
 * them registered. This runs the real setup against stand-in services and
 * holds every registration to having been removed — so a handler added
 * without its cleanup entry fails here, by name, instead of drifting again.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ipcMain } = vi.hoisted(() => {
  const handled = new Set<string>();
  const listened = new Set<string>();
  const removedHandlers = new Set<string>();
  const removedListeners = new Set<string>();
  return {
    ipcMain: {
      handled,
      listened,
      removedHandlers,
      removedListeners,
      handle: vi.fn((channel: string) => { handled.add(channel); }),
      on: vi.fn((channel: string) => { listened.add(channel); }),
      once: vi.fn((channel: string) => { listened.add(channel); }),
      removeHandler: vi.fn((channel: string) => { removedHandlers.add(channel); }),
      removeAllListeners: vi.fn((channel: string) => { removedListeners.add(channel); }),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain,
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0', getName: () => 'philibert' },
  BrowserWindow: vi.fn(),
  dialog: {},
  shell: {},
  clipboard: { writeText: vi.fn() },
}));

vi.mock('../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogLevel: vi.fn(),
}));

import { setupIPC } from '../index';

/**
 * A service that answers any method with a stub resolving to nothing. Setup
 * only registers handlers and subscribes to events — one of them waits on a
 * service call before subscribing, hence the promise — and what a handler
 * does is the business of each module's own tests.
 */
function standIn(): never {
  return new Proxy({}, {
    get: (_target, key) => (key === 'then' ? undefined : vi.fn(async () => undefined)),
  }) as never;
}

describe('IPC teardown', () => {
  beforeEach(() => {
    ipcMain.handled.clear();
    ipcMain.listened.clear();
    ipcMain.removedHandlers.clear();
    ipcMain.removedListeners.clear();
  });

  it('removes every handler and listener that setup registered', () => {
    const cleanup = setupIPC({
      authService: standIn(),
      configService: standIn(),
      claudeService: standIn(),
      fileWatcher: standIn(),
      gitService: standIn(),
      mcpService: standIn(),
      projectPermissionService: standIn(),
      conversationService: standIn(),
      updateService: standIn(),
    }, () => null);

    // Guards the premise: an empty registration set would pass vacuously.
    expect(ipcMain.handled.size).toBeGreaterThan(50);

    cleanup();

    const handlersLeft = [...ipcMain.handled].filter((c) => !ipcMain.removedHandlers.has(c));
    const listenersLeft = [...ipcMain.listened].filter((c) => !ipcMain.removedListeners.has(c));
    expect(handlersLeft, 'registered, but not in the cleanup list').toEqual([]);
    expect(listenersLeft, 'listened to, but not in the cleanup list').toEqual([]);
  });
});
