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

import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';

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
    downloadUpdate: vi.fn(),
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
import UpdateService, { FIRST_UPDATE_CHECK_DELAY_MS, UPDATE_CHECK_INTERVAL_MS, manualInstallCommand } from '../UpdateService';

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

    expect(await updates.installUpdate()).toEqual({
      installed: false,
      reason: 'failed',
      error: 'Command pkexec exited with code 127',
      downloadedFile: DEB,
      installCommand: `sudo apt install '${DEB}'`,
      releaseUrl: 'https://dev.web.wr0ng.name/wrongname/philibert/-/releases/v0.25.11-rc.2',
    });
  });

  it('reports it installed when the installer raised nothing — the app then quits', async () => {
    const updates = await downloaded();
    mockAutoUpdater.quitAndInstall.mockImplementation(() => undefined);

    expect(await updates.installUpdate()).toEqual({ installed: true });
  });

  it('stops listening for errors once the install has been asked for', async () => {
    const updates = await downloaded();
    mockAutoUpdater.quitAndInstall.mockImplementation(() => undefined);
    await updates.installUpdate();

    // A later error, from another check, is not this install's.
    mockAutoUpdater.quitAndInstall.mockImplementation(() => undefined);
    mockAutoUpdater.emit('error', new Error('later'));
    expect(await updates.installUpdate()).toEqual({ installed: true });
  });

  describe('made ready to quit first (setBeforeInstall)', () => {
    it('installs only once ready: asked and saved before, as installing quits the app', async () => {
      const updates = await downloaded();
      const order: string[] = [];
      updates.setBeforeInstall(async () => { order.push('prepared'); return true; }, () => order.push('abandoned'));
      mockAutoUpdater.quitAndInstall.mockImplementation(() => { order.push('installed'); });

      expect(await updates.installUpdate()).toEqual({ installed: true });
      expect(order).toEqual(['prepared', 'installed']);
    });

    it('installs nothing when the user keeps working', async () => {
      const updates = await downloaded();
      updates.setBeforeInstall(async () => false, vi.fn());

      expect(await updates.installUpdate()).toEqual({ installed: false, reason: 'kept-working' });
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
    });

    it('says the quit was abandoned when the install failed and the app stays open', async () => {
      const updates = await downloaded();
      const abandoned = vi.fn();
      updates.setBeforeInstall(async () => true, abandoned);
      mockAutoUpdater.quitAndInstall.mockImplementation(() => {
        mockAutoUpdater.emit('error', new Error('Command pkexec exited with code 127'));
      });

      expect(await updates.installUpdate()).toMatchObject({ installed: false, reason: 'failed' });
      expect(abandoned).toHaveBeenCalledTimes(1);
    });

    it('does not say so when it installed', async () => {
      const updates = await downloaded();
      const abandoned = vi.fn();
      updates.setBeforeInstall(async () => true, abandoned);
      mockAutoUpdater.quitAndInstall.mockImplementation(() => undefined);

      await updates.installUpdate();

      expect(abandoned).not.toHaveBeenCalled();
    });
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

    const result = await service().checkForUpdates();

    expect(mockAutoUpdater.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://dev.web.wr0ng.name/api/v4/projects/wrongname%2Fphilibert/packages/generic/releases/0.25.11-rc.2',
    });
    expect(result).toEqual({ status: 'available', update: { version: '0.25.11-rc.2' } });
  });

  it('says so when the updater does not update this kind of install', async () => {
    const warn = vi.spyOn(logger, 'warn');
    mockAutoUpdater.checkForUpdates.mockResolvedValue(null);

    const result = await service().checkForUpdates();

    expect(result).toEqual({ status: 'failed', reason: 'unsupported-install', version: '0.25.11-rc.2' });
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

    expect(result).toEqual({ status: 'failed', reason: 'no-feed', version: '0.25.11-rc.2' });
    expect(warn).toHaveBeenCalledWith('The release has no update feed for this platform', expect.objectContaining({
      platform: process.platform,
    }));
    expect(info).not.toHaveBeenCalledWith('No releases published to package registry yet');
  });

  it('does not ask the updater when already on the newest release', async () => {
    releasesAre(['v0.25.10', 'v0.25.11-rc.1']);

    const result = await service().checkForUpdates();

    expect(result).toEqual({ status: 'up-to-date', latestVersion: '0.25.11-rc.1' });
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('says there is no release on the channel when there is none', async () => {
    releasesAre([]);

    expect(await service().checkForUpdates()).toEqual({ status: 'failed', reason: 'no-release' });
  });

  it('says why the check failed, with the release it found', async () => {
    mockAutoUpdater.checkForUpdates.mockRejectedValue(new Error('net::ERR_CONNECTION_RESET'));

    expect(await service().checkForUpdates())
      .toEqual({ status: 'failed', reason: 'error', version: '0.25.11-rc.2', message: 'net::ERR_CONNECTION_RESET' });
  });

  it('asked again while it checks, joins the check under way', async () => {
    let answer!: (value: unknown) => void;
    mockAutoUpdater.checkForUpdates.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const updates = service();

    const first = updates.checkForUpdates();
    const second = updates.checkForUpdates();
    await vi.waitFor(() => expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalled());
    answer({ updateInfo: { version: '0.25.11-rc.2' } });

    expect(await second).toEqual(await first);
    expect(mockNet.request).toHaveBeenCalledTimes(1);
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });
});

describe('checking once an update is downloading or downloaded', () => {
  async function offered(): Promise<UpdateService> {
    mockAutoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.25.11-rc.2' } });
    const updates = service();
    await updates.checkForUpdates();
    vi.clearAllMocks();
    return updates;
  }

  it('says it is downloading, without checking', async () => {
    const updates = await offered();
    mockAutoUpdater.downloadUpdate.mockReturnValue(new Promise(() => {}));
    void updates.downloadUpdate();

    expect(await updates.checkForUpdates()).toEqual({ status: 'pending', version: '0.25.11-rc.2', downloaded: false });
    expect(mockNet.request).not.toHaveBeenCalled();
  });

  it('says it is downloaded, without checking', async () => {
    const updates = await offered();
    mockAutoUpdater.emit('update-downloaded', { version: '0.25.11-rc.2', downloadedFile: '/tmp/philibert.deb' });

    expect(await updates.checkForUpdates()).toEqual({ status: 'pending', version: '0.25.11-rc.2', downloaded: true });
    expect(mockNet.request).not.toHaveBeenCalled();
  });

  it('checks again once a download failed', async () => {
    const updates = await offered();
    mockAutoUpdater.downloadUpdate.mockRejectedValue(new Error('net::ERR_CONNECTION_RESET'));
    await expect(updates.downloadUpdate()).rejects.toThrow();
    mockAutoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.25.11-rc.2' } });

    expect(await updates.checkForUpdates()).toEqual({ status: 'available', update: { version: '0.25.11-rc.2' } });
  });
});

describe('checking by itself while the app runs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockAutoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.25.11-rc.2' } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('checks shortly after starting, then every day', async () => {
    const updates = service();
    updates.startPeriodicChecks();

    await vi.advanceTimersByTimeAsync(FIRST_UPDATE_CHECK_DELAY_MS - 1);
    expect(mockNet.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mockNet.request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(mockNet.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(mockNet.request).toHaveBeenCalledTimes(3);
    updates.stopPeriodicChecks();
  });

  it('every day is 24 hours', () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('skips a day while an update is downloaded, waiting to be installed', async () => {
    const updates = service();
    updates.startPeriodicChecks();
    await vi.advanceTimersByTimeAsync(FIRST_UPDATE_CHECK_DELAY_MS);
    mockAutoUpdater.emit('update-downloaded', { version: '0.25.11-rc.2', downloadedFile: '/tmp/philibert.deb' });

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);

    expect(mockNet.request).toHaveBeenCalledTimes(1);
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    updates.stopPeriodicChecks();
  });

  it('stops checking once stopped, as the app quits', async () => {
    const updates = service();
    updates.startPeriodicChecks();

    updates.stopPeriodicChecks();
    await vi.advanceTimersByTimeAsync(FIRST_UPDATE_CHECK_DELAY_MS + 2 * UPDATE_CHECK_INTERVAL_MS);

    expect(mockNet.request).not.toHaveBeenCalled();
  });

  it('started again, keeps one schedule, not two', async () => {
    const updates = service();
    updates.startPeriodicChecks();
    updates.startPeriodicChecks();

    await vi.advanceTimersByTimeAsync(FIRST_UPDATE_CHECK_DELAY_MS + UPDATE_CHECK_INTERVAL_MS);

    expect(mockNet.request).toHaveBeenCalledTimes(2);
    updates.stopPeriodicChecks();
  });
});
