// @vitest-environment jsdom
/**
 * An update, from the release offering it to installing it: what it changes,
 * shown so it can be planned, and what to do when it cannot be installed.
 *
 * The real path: GitLab's list of releases, the feed the release job writes
 * (scripts/release-notes.mjs puts RELEASE_NOTES.md's section in it) read by
 * electron-updater's own parser, then the real UpdateService and
 * ConfigService, the real update and window IPC handlers, the real preload,
 * and the real banner and its dialog.
 *
 * Faked: Electron (the window, IPC transport, net, the clipboard),
 * electron-store and the filesystem, and electron-updater's network and
 * installer side — the autoUpdater that fetches the feed and runs the
 * installer. It hands over what it parsed, as it does after fetching, and
 * records the download and install it is asked for.
 *
 * Under jsdom: the notes are bound with v-html, and DOMPurify does not
 * sanitize inside happy-dom (see utils/__tests__/markdown.sanitize.test.ts).
 */

import { flushPromises, mount } from '@vue/test-utils';
import { parseUpdateInfo } from 'electron-updater/out/providers/Provider';
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';

vi.mock('node:fs', async () => (await import('./support/real-stack')).fakeFsModule());
vi.mock('electron', async () => (await import('./support/real-stack')).fakeElectronModule());
vi.mock('../../../main/utils/paths', () => ({
  getConversationsPath: () => '/conversations',
  isPathWithin: (target: string, root: string) => target.startsWith(root),
}));
vi.mock('../../../main/utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogLevel: vi.fn(),
}));
vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
/** electron-store: the settings file, in memory, with the defaults it is given. */
vi.mock('electron-store', () => ({
  default: class {
    private values: Record<string, unknown>;
    constructor(options: { defaults?: Record<string, unknown> }) { this.values = { ...options.defaults }; }
    get(key: string, fallback?: unknown) { return key in this.values ? this.values[key] : fallback; }
    set(key: string, value: unknown) { this.values[key] = value; }
    delete(key: string) { delete this.values[key]; }
  },
}));

/** electron-updater's autoUpdater: fetching and installing are its, and not done here. */
type FakeAutoUpdater = import('node:events').EventEmitter
  & Record<'setFeedURL' | 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall', Mock>;
const autoUpdater = vi.hoisted(() => ({ value: null as FakeAutoUpdater | null }));
vi.mock('electron-updater', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  const updater = Object.assign(new Emitter(), {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  });
  autoUpdater.value = updater;
  return { autoUpdater: updater };
});

import { feedNotes, whatsNew } from '../../../../scripts/release-notes.mjs';
import { setupUpdateIPC } from '../../../main/ipc/update';
import { setupWindowIPC } from '../../../main/ipc/window';
import ConfigService from '../../../main/services/ConfigService';
import { ConversationService } from '../../../main/services/ConversationService';
import UpdateService from '../../../main/services/UpdateService';
import '../../../preload/preload';
import UpdateBanner from '../../components/shared/UpdateBanner.vue';

import { startRealStack, emitIpc, netResponses, clipboardWrites } from './support/real-stack';

const RELEASE_NOTES = `# What's new in Philibert

## 0.31.1

- **Updates say what's new**, so you can pick a good moment to install them.
- <img src=x onerror="alert(1)">The release page lists what changed.
`;

/** The Windows feed as the release job writes it: its fields, then the notes. */
function feed(version: string, notes: string | null): string {
  return `version: ${version}\npath: Philibert-Setup-${version}.exe\nsha512: abc\nreleaseDate: 2026-11-16T10:00:00Z\n`
    + (notes === null ? '' : feedNotes(notes));
}

let banner: ReturnType<typeof mount> | null = null;

/** The main process's window: what UpdateService sends reaches the renderer's listeners, copied as IPC copies. */
const mainWindow = {
  isDestroyed: () => false,
  webContents: {
    send: (channel: string, ...args: unknown[]) => emitIpc(channel, ...structuredClone(args)),
  },
};

beforeEach(async () => {
  await startRealStack({ ConversationService: ConversationService as never });
  const updater = autoUpdater.value!;
  updater.removeAllListeners();
  for (const method of ['setFeedURL', 'checkForUpdates', 'downloadUpdate', 'quitAndInstall'] as const) {
    // Reset, not cleared: a test's failing installer must not outlive it.
    updater[method].mockReset();
  }
  setupUpdateIPC(new UpdateService(() => mainWindow as never, new ConfigService()));
  setupWindowIPC();
  banner = mount(UpdateBanner, { attachTo: document.body });
});

afterEach(() => {
  banner?.unmount();
  banner = null;
  document.body.innerHTML = '';
});

/** electron-updater, having fetched and parsed the release's feed, says an update is there. */
async function offer(version: string, notes: string | null): Promise<void> {
  const info = parseUpdateInfo(feed(version, notes), 'latest.yml', new URL('https://example.test/latest.yml'));
  autoUpdater.value!.emit('update-available', info);
  await flushPromises();
}

/** The dialog, teleported to the body; null when closed. */
function dialog(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"]');
}

function dialogButton(label: string): HTMLButtonElement | undefined {
  return [...(dialog()?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === label);
}

async function openWhatsNew(): Promise<void> {
  await banner!.find('.update-notes-open').trigger('click');
  await flushPromises();
}

describe("an update's what's new, from its feed to the dialog", () => {
  it('shows the notes the release wrote, in a dialog, leaving the banner one row', async () => {
    await offer('0.31.1', whatsNew(RELEASE_NOTES, '0.31.1'));
    expect(banner!.text()).toContain('Update available: v0.31.1');
    expect(dialog()).toBeNull();
    // Right after the version, not among the actions.
    const link = banner!.find('.update-notes-open');
    expect(link.text()).toBe("See what's new");
    expect(link.element.parentElement!.textContent).toContain('Update available: v0.31.1');

    await openWhatsNew();
    expect(dialog()!.textContent).toContain("What's new in v0.31.1");
    const notes = dialog()!.querySelector('.update-notes')!;
    expect(notes.querySelector('strong')!.textContent).toBe('Updates say what\'s new');
    expect(notes.querySelectorAll('li')).toHaveLength(2);
    expect(banner!.find('.update-banner .update-notes').exists()).toBe(false);
  });

  it('renders them sanitized, as a message is', async () => {
    await offer('0.31.1', whatsNew(RELEASE_NOTES, '0.31.1'));
    await openWhatsNew();

    const notes = dialog()!.querySelector('.update-notes')!;
    expect(notes.innerHTML).not.toContain('onerror');
    expect(notes.textContent).toContain('The release page lists what changed.');
  });

  it('closes', async () => {
    await offer('0.31.1', whatsNew(RELEASE_NOTES, '0.31.1'));
    await openWhatsNew();

    dialogButton('Close')!.click();
    await flushPromises();
    expect(dialog()).toBeNull();
  });

  it('downloads from the dialog, having read what the update changes', async () => {
    await offer('0.31.1', whatsNew(RELEASE_NOTES, '0.31.1'));
    await openWhatsNew();

    dialogButton('Download')!.click();
    await flushPromises();
    expect(autoUpdater.value!.downloadUpdate).toHaveBeenCalledOnce();
    expect(dialog()).toBeNull();
    expect(banner!.text()).toContain('Downloading v0.31.1');
  });

  it('restarts from the dialog once downloaded, to pick when', async () => {
    await offer('0.31.1', whatsNew(RELEASE_NOTES, '0.31.1'));
    autoUpdater.value!.emit('update-downloaded', { downloadedFile: '/tmp/Philibert-Setup-0.31.1.exe' });
    await flushPromises();
    expect(banner!.text()).toContain('Update v0.31.1 ready to install');

    await openWhatsNew();
    expect(dialogButton('Download')).toBeUndefined();
    dialogButton('Restart Now')!.click();
    await flushPromises();
    expect(autoUpdater.value!.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('is not offered for a release whose feed has no notes', async () => {
    await offer('0.30.1', null);
    expect(banner!.text()).toContain('Update available: v0.30.1');
    expect(banner!.find('.update-notes-open').exists()).toBe(false);
  });

  it('is closed for the next update offered', async () => {
    await offer('0.31.1', whatsNew(RELEASE_NOTES, '0.31.1'));
    await openWhatsNew();

    await offer('0.31.2', '- Another fix.');
    expect(dialog()).toBeNull();
  });
});

describe('installing the downloaded update', () => {
  const DEB = '/home/u/.cache/Philibert/pending/philibert_0.31.1_amd64.deb';
  const RELEASES = 'https://dev.web.wr0ng.name/api/v4/projects/wrongname%2Fphilibert/releases';

  /**
   * v0.31.1 offered by the update check, as the app asks for it: GitLab lists
   * the release, electron-updater reads its feed, and it is downloaded.
   */
  async function downloaded(): Promise<void> {
    netResponses.set(RELEASES, { statusCode: 200, body: JSON.stringify([{ tag_name: 'v0.31.1' }, { tag_name: 'v0.31.0' }]) });
    const updater = autoUpdater.value!;
    updater.checkForUpdates.mockImplementation(async () => {
      const updateInfo = parseUpdateInfo(feed('0.31.1', null), 'latest-linux.yml', new URL('https://example.test/latest-linux.yml'));
      updater.emit('update-available', updateInfo);
      return { updateInfo };
    });
    await (window as unknown as { electron: { update: { check: () => Promise<unknown> } } }).electron.update.check();
    updater.emit('update-downloaded', { downloadedFile: DEB });
    await flushPromises();
  }

  function restartNow() {
    return banner!.findAll('button').find((b) => b.text() === 'Restart Now');
  }

  /** The installer, run by electron-updater, fails: it reports an error event during the call, and throws nothing. */
  function installerFails(message: string): void {
    const updater = autoUpdater.value!;
    updater.quitAndInstall.mockImplementation(() => {
      updater.emit('error', new Error(message));
    });
  }

  it('offers a stable channel the stable release, never a newer candidate', async () => {
    netResponses.set(RELEASES, {
      statusCode: 200,
      body: JSON.stringify([{ tag_name: 'v0.31.2-rc.1' }, { tag_name: 'v0.31.1' }]),
    });
    autoUpdater.value!.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.31.1' } });

    await (window as unknown as { electron: { update: { check: () => Promise<unknown> } } }).electron.update.check();

    expect(autoUpdater.value!.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://dev.web.wr0ng.name/api/v4/projects/wrongname%2Fphilibert/packages/generic/releases/0.31.1',
    });
  });

  it('says why it could not, and gives the command and the release page', async () => {
    await downloaded();
    installerFails('Command pkexec exited with code 127');

    await restartNow()!.trigger('click');
    await flushPromises();

    expect(banner!.text()).toContain('Update v0.31.1 could not be installed: Command pkexec exited with code 127');
    expect(banner!.find('.update-install-command').text()).toBe(`sudo apt install '${DEB}'`);
    expect(banner!.find('a').attributes('href')).toBe('https://dev.web.wr0ng.name/wrongname/philibert/-/releases/v0.31.1');
    expect(restartNow()).toBeUndefined();
  });

  it('copies the command to the clipboard', async () => {
    await downloaded();
    installerFails('Command pkexec exited with code 127');
    await restartNow()!.trigger('click');
    await flushPromises();

    await banner!.findAll('button').find((b) => b.text() === 'Copy')!.trigger('click');
    await flushPromises();

    expect(clipboardWrites).toEqual([`sudo apt install '${DEB}'`]);
    expect(banner!.text()).toContain('Copied');
  });

  it('keeps offering to restart while the install goes ahead', async () => {
    await downloaded();

    await restartNow()!.trigger('click');
    await flushPromises();

    expect(autoUpdater.value!.quitAndInstall).toHaveBeenCalledOnce();
    expect(banner!.find('.update-install-failure').exists()).toBe(false);
    expect(restartNow()).toBeDefined();
  });
});
