/**
 * Checking for an update: what the service says when the updater cannot
 * update this install, or the release has no feed for this platform.
 *
 * Reported: on Linux, updates never came, and nothing in the log said why —
 * electron-updater took the .deb install for an AppImage and switched itself
 * off, and the release had no latest-linux.yml, whose 404 was logged as "No
 * releases published". Electron and electron-updater are the boundaries
 * mocked; the logger is the real one, watched.
 */

import { EventEmitter } from 'node:events';

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockApp, mockNet, mockAutoUpdater } = vi.hoisted(() => {
  /** electron-updater's autoUpdater is an EventEmitter; its listeners are kept here. */
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const autoUpdater = {
    setFeedURL: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== listener));
    }),
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    reset() { listeners.clear(); },
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
    requestHeaders: undefined as unknown,
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: null as unknown,
  };
  return {
    mockApp: {
      getVersion: vi.fn(() => '0.25.11-rc.1'),
      getPath: vi.fn(() => '/mock/user/data'),
    },
    mockNet: { request: vi.fn() },
    mockAutoUpdater: autoUpdater,
  };
});

vi.mock('electron', () => ({ app: mockApp, net: mockNet, BrowserWindow: class {} }));
vi.mock('electron-updater', () => ({ autoUpdater: mockAutoUpdater }));

import logger from '../../utils/logger';
import type ConfigService from '../ConfigService';
import UpdateService, { manualInstallCommand } from '../UpdateService';

/** The GitLab releases API answering with these tags. */
function releasesAre(tags: string[]): void {
  mockNet.request.mockImplementation(() => {
    const request = new EventEmitter() as EventEmitter & { setHeader: () => void; end: () => void };
    request.setHeader = () => undefined;
    request.end = () => {
      const response = new EventEmitter() as EventEmitter & { statusCode: number };
      response.statusCode = 200;
      request.emit('response', response);
      response.emit('data', Buffer.from(JSON.stringify(tags.map((tag_name) => ({ tag_name })))));
      response.emit('end');
    };
    return request;
  });
}

function service(): UpdateService {
  const config = { getUpdateChannel: async () => 'rc' } as unknown as ConfigService;
  return new UpdateService(() => null, config);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAutoUpdater.reset();
  releasesAre(['v0.25.11-rc.1', 'v0.25.11-rc.2']);
});

describe('the updater', () => {
  // What it logs — the command an install runs and what it printed when it
  // failed — used to go to a console no installed app has.
  it('logs into main.log', () => {
    service();

    expect(mockAutoUpdater.logger).toBe(logger);
  });
});

// Reported: on Linux, "Restart now" did nothing. pkexec found no polkit
// agent for the app's process and exited 127; electron-updater reported it
// as an event, not a throw, so nothing reached the button.
describe('installing the downloaded update', () => {
  const DEB = '/home/u/.cache/Philibert/pending/philibert_0.25.12_amd64.deb';

  async function downloaded(): Promise<UpdateService> {
    const updates = service();
    mockAutoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.25.11-rc.2' } });
    await updates.checkForUpdates();
    mockAutoUpdater.emit('update-downloaded', { version: '0.25.11-rc.2', downloadedFile: DEB });
    return updates;
  }

  it('says why it could not, with the file, a command to install it by hand and the release page', async () => {
    const updates = await downloaded();
    mockAutoUpdater.quitAndInstall.mockImplementation(() => {
      mockAutoUpdater.emit('error', new Error('Command pkexec exited with code 127'));
    });

    expect(updates.installUpdate()).toEqual({
      installed: false,
      error: 'Command pkexec exited with code 127',
      downloadedFile: DEB,
      installCommand: `sudo apt install '${DEB}'`,
      releaseUrl: 'https://dev.web.wr0ng.name/wrongname/philibert/-/releases/v0.25.11-rc.2',
    });
  });

  it('reports it installed when the installer raised nothing — the app then quits', async () => {
    const updates = await downloaded();
    mockAutoUpdater.quitAndInstall.mockImplementation(() => undefined);

    expect(updates.installUpdate()).toEqual({ installed: true });
  });

  it('stops listening for errors once the install has been asked for', async () => {
    const updates = await downloaded();
    mockAutoUpdater.quitAndInstall.mockImplementation(() => undefined);
    updates.installUpdate();

    // A later error, from another check, is not this install's.
    mockAutoUpdater.quitAndInstall.mockImplementation(() => undefined);
    mockAutoUpdater.emit('error', new Error('later'));
    expect(updates.installUpdate()).toEqual({ installed: true });
  });
});

describe('the command to install a package by hand', () => {
  it('installs a .deb with apt and an .rpm with dnf', () => {
    expect(manualInstallCommand('/tmp/p_1_amd64.deb')).toBe("sudo apt install '/tmp/p_1_amd64.deb'");
    expect(manualInstallCommand('/tmp/p-1.x86_64.rpm')).toBe("sudo dnf install '/tmp/p-1.x86_64.rpm'");
  });

  it('quotes the path, spaces, tildes and quotes included', () => {
    expect(manualInstallCommand("/home/o'neil/my files/p_0.1~rc.1_amd64.deb"))
      .toBe(`sudo apt install '/home/o'\\''neil/my files/p_0.1~rc.1_amd64.deb'`);
  });

  it('has none for anything else', () => {
    expect(manualInstallCommand('C:\\Temp\\Philibert-Setup.exe')).toBeNull();
  });
});

describe('checking for an update', () => {
  it('points the updater at the newest release of the channel and reports it', async () => {
    mockAutoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.25.11-rc.2' } });

    const info = await service().checkForUpdates();

    expect(mockAutoUpdater.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://dev.web.wr0ng.name/api/v4/projects/wrongname%2Fphilibert/packages/generic/releases/0.25.11-rc.2',
    });
    expect(info?.version).toBe('0.25.11-rc.2');
  });

  it('says so when the updater does not update this kind of install', async () => {
    const warn = vi.spyOn(logger, 'warn');
    mockAutoUpdater.checkForUpdates.mockResolvedValue(null);

    const info = await service().checkForUpdates();

    expect(info).toBeNull();
    expect(warn).toHaveBeenCalledWith('The updater is not active for this install', {
      platform: process.platform,
      latestVersion: '0.25.11-rc.2',
    });
  });

  it("says the release has no feed for this platform, not that there is no release", async () => {
    const warn = vi.spyOn(logger, 'warn');
    const info = vi.spyOn(logger, 'info');
    mockAutoUpdater.checkForUpdates.mockRejectedValue(
      new Error('Cannot find latest-linux.yml in the latest release artifacts (…/latest-linux.yml): HttpError: 404'),
    );

    const result = await service().checkForUpdates();

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith('The release has no update feed for this platform', expect.objectContaining({
      platform: process.platform,
    }));
    expect(info).not.toHaveBeenCalledWith('No releases published to package registry yet');
  });

  it('does not ask the updater when already on the newest release', async () => {
    releasesAre(['v0.25.10', 'v0.25.11-rc.1']);

    const info = await service().checkForUpdates();

    expect(info).toBeNull();
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });
});
