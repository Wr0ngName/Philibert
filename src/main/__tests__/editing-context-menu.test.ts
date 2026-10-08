/**
 * Right-click editing menu for text fields.
 *
 * Electron ships no default context menu — Chromium's lives in the browser UI
 * layer that Electron does not provide — so right-clicking the prompt textarea
 * produced nothing until the app built the menu itself. These tests pin the
 * two things that make the fix correct rather than merely present: that it
 * fires for editable fields, and that it stays out of the way everywhere else
 * so it cannot double up with the Vue menu MessageItem renders for messages.
 *
 * Mocks only the Electron boundary.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above the module body, so these have to be
// created in a hoisted block to be visible inside the factory.
const { popup, buildFromTemplate } = vi.hoisted(() => {
  const popupFn = vi.fn();
  return {
    popup: popupFn,
    // Typed with the template parameter so the assertions below can read it.
    buildFromTemplate: vi.fn((_template: unknown) => ({ popup: popupFn })),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(
    vi.fn(),
    { fromWebContents: vi.fn(() => ({ id: 1 })) },
  ),
  Menu: { buildFromTemplate },
  shell: { openExternal: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp/test'), getAppPath: vi.fn(() => '/app'), getName: vi.fn(() => 'test') },
}));

vi.mock('../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../utils/debugLog', () => ({ debugLog: vi.fn() }));

import { installEditingContextMenu } from '../window';

type Handler = (event: unknown, params: Record<string, unknown>) => void;

/** A WebContents stand-in that captures the context-menu handler. */
function fakeWebContents(): { on: ReturnType<typeof vi.fn>; fire: (params: Record<string, unknown>) => void } {
  let handler: Handler | undefined;
  const on = vi.fn((event: string, cb: Handler) => {
    if (event === 'context-menu') handler = cb;
  });
  return {
    on,
    fire: (params) => handler?.({}, params),
  };
}

const ALL_ALLOWED = {
  canUndo: true,
  canRedo: true,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canDelete: true,
  canSelectAll: true,
};

function roles(): string[] {
  const template = buildFromTemplate.mock.calls[0][0] as { role?: string }[];
  return template.filter(i => i.role).map(i => i.role as string);
}

beforeEach(() => {
  buildFromTemplate.mockClear();
  popup.mockClear();
});

describe('installEditingContextMenu', () => {
  it('shows cut, copy and paste in an editable field', () => {
    const wc = fakeWebContents();
    installEditingContextMenu(wc as never);
    wc.fire({ isEditable: true, editFlags: ALL_ALLOWED });

    expect(buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(roles()).toEqual(
      expect.arrayContaining(['cut', 'copy', 'paste', 'selectAll', 'undo', 'redo']),
    );
    expect(popup).toHaveBeenCalledTimes(1);
  });

  it('shows no menu for non-editable content', () => {
    // This event fires even when the renderer called preventDefault, so a
    // menu here would appear on top of MessageItem's own Vue menu.
    const wc = fakeWebContents();
    installEditingContextMenu(wc as never);
    wc.fire({ isEditable: false, editFlags: ALL_ALLOWED });

    expect(buildFromTemplate).not.toHaveBeenCalled();
    expect(popup).not.toHaveBeenCalled();
  });

  it('greys out entries the field cannot perform', () => {
    // An empty field with nothing on the clipboard should not offer live
    // cut/copy/paste entries that silently do nothing.
    const wc = fakeWebContents();
    installEditingContextMenu(wc as never);
    wc.fire({
      isEditable: true,
      editFlags: { ...ALL_ALLOWED, canCut: false, canCopy: false, canPaste: false },
    });

    const template = buildFromTemplate.mock.calls[0][0] as { role?: string; enabled?: boolean }[];
    const byRole = (role: string) => template.find(i => i.role === role);
    expect(byRole('cut')?.enabled).toBe(false);
    expect(byRole('copy')?.enabled).toBe(false);
    expect(byRole('paste')?.enabled).toBe(false);
    expect(byRole('selectAll')?.enabled).toBe(true);
  });

  it('registers exactly one context-menu listener', () => {
    const wc = fakeWebContents();
    installEditingContextMenu(wc as never);
    expect(wc.on).toHaveBeenCalledTimes(1);
    expect(wc.on).toHaveBeenCalledWith('context-menu', expect.any(Function));
  });
});
