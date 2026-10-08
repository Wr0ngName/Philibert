/**
 * Microphone permission.
 *
 * Electron's default handler denies media requests, so without this
 * `getUserMedia` rejects and dictation can never start. The grant has to be
 * narrow — these tests pin that it covers audio and nothing else, because the
 * easy mistake here is a blanket allow that also hands out the camera.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { setPermissionRequestHandler } = vi.hoisted(() => ({
  setPermissionRequestHandler: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(vi.fn(), { fromWebContents: vi.fn(() => ({ id: 1 })) }),
  Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
  shell: { openExternal: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp/test'), getAppPath: vi.fn(() => '/app'), getName: vi.fn(() => 'test') },
}));

vi.mock('../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../utils/debugLog', () => ({ debugLog: vi.fn() }));

import { installMediaPermissionHandler } from '../window';

type Handler = (
  contents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: Record<string, unknown>,
) => void;

/** A BrowserWindow stand-in that captures the installed permission handler. */
function fakeWindow(): { window: unknown; ask: (permission: string, details?: Record<string, unknown>) => boolean } {
  const window = {
    webContents: { session: { setPermissionRequestHandler } },
  };
  return {
    window,
    ask: (permission, details = {}) => {
      const handler = setPermissionRequestHandler.mock.calls[0][0] as Handler;
      let granted: boolean | undefined;
      handler({}, permission, (value) => { granted = value; }, details);
      expect(granted, 'handler must always answer the callback').toBeTypeOf('boolean');
      return granted as boolean;
    },
  };
}

beforeEach(() => {
  setPermissionRequestHandler.mockClear();
});

describe('installMediaPermissionHandler', () => {
  it('grants an audio-only media request', () => {
    const { window, ask } = fakeWindow();
    installMediaPermissionHandler(window as never);
    expect(ask('media', { mediaTypes: ['audio'] })).toBe(true);
  });

  it('denies a request that includes video', () => {
    // Nothing in this app needs a camera.
    const { window, ask } = fakeWindow();
    installMediaPermissionHandler(window as never);
    expect(ask('media', { mediaTypes: ['audio', 'video'] })).toBe(false);
    expect(ask('media', { mediaTypes: ['video'] })).toBe(false);
  });

  it('denies a media request with no stated media types', () => {
    // An unexpected shape must not widen the grant.
    const { window, ask } = fakeWindow();
    installMediaPermissionHandler(window as never);
    expect(ask('media', {})).toBe(false);
    expect(ask('media', { mediaTypes: [] })).toBe(false);
  });

  it('denies every other permission', () => {
    const { window, ask } = fakeWindow();
    installMediaPermissionHandler(window as never);
    for (const permission of ['geolocation', 'notifications', 'midi', 'openExternal', 'clipboard-read']) {
      expect(ask(permission, { mediaTypes: ['audio'] })).toBe(false);
    }
  });

  it('installs exactly one handler', () => {
    const { window } = fakeWindow();
    installMediaPermissionHandler(window as never);
    expect(setPermissionRequestHandler).toHaveBeenCalledTimes(1);
  });
});
