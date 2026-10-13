/**
 * Warning before quitting with work in flight.
 *
 * The part worth testing without Electron is the decision: whether to warn at
 * all, and what the warning says. Warning when nothing is running would put a
 * dialog in front of every ordinary close, and staying silent when something
 * is running is the gap this closes — quitting ends the SDK sessions, so a
 * turn mid-answer and the background tasks it started are lost with no way to
 * resume them.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

vi.mock('../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogLevel: vi.fn(),
}));

import { describeRunningWork } from '../window';

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
    // A turn can finish while its tasks keep running, which is now the
    // deliberate behaviour of Stop — so this is a real case, not a corner.
    expect(describeRunningWork({ turns: 0, tasks: 1 })).toBe('1 background task still running');
    expect(describeRunningWork({ turns: 0, tasks: 2 })).toBe('2 background tasks still running');
  });

  it('reports both when both are in flight', () => {
    expect(describeRunningWork({ turns: 2, tasks: 1 })).toBe(
      '2 conversations still working and 1 background task still running',
    );
  });
});
