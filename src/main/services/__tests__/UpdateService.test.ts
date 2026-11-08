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

const { mockApp, mockNet, mockAutoUpdater } = vi.hoisted(() => ({
  mockApp: {
    getVersion: vi.fn(() => '0.25.11-rc.1'),
    getPath: vi.fn(() => '/mock/user/data'),
  },
  mockNet: { request: vi.fn() },
  mockAutoUpdater: {
    setFeedURL: vi.fn(),
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    requestHeaders: undefined as unknown,
    autoDownload: true,
    autoInstallOnAppQuit: false,
  },
}));

vi.mock('electron', () => ({ app: mockApp, net: mockNet, BrowserWindow: class {} }));
vi.mock('electron-updater', () => ({ autoUpdater: mockAutoUpdater }));

import logger from '../../utils/logger';
import type ConfigService from '../ConfigService';
import UpdateService from '../UpdateService';

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
  releasesAre(['v0.25.11-rc.1', 'v0.25.11-rc.2']);
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
