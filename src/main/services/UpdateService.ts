/**
 * Auto-update service using Electron's built-in autoUpdater (Squirrel.Windows)
 *
 * Uses Squirrel's native update mechanism instead of electron-updater:
 * 1. Query GitLab Releases API to find the latest release tag
 * 2. Point Squirrel at the version's package directory (RELEASES + nupkg)
 * 3. Squirrel's Update.exe (already installed) applies the nupkg delta
 *
 * This avoids the "dummy update.exe" problem that occurs when electron-updater
 * tries to run cross-compiled Setup.exe files (Mono can't embed PE resources).
 */

import { BrowserWindow, app, autoUpdater, net } from 'electron';

import { IPC_CHANNELS, UpdateInfo } from '../../shared/types';
import { createSender } from '../utils/ipc-helpers';
import logger from '../utils/logger';

const GITLAB_HOST = 'https://dev.web.wr0ng.name';
const GITLAB_PROJECT_ID = 'wrongname%2Fcline-gui';

const RELEASES_API = `${GITLAB_HOST}/api/v4/projects/${GITLAB_PROJECT_ID}/releases`;
const PACKAGES_API = `${GITLAB_HOST}/api/v4/projects/${GITLAB_PROJECT_ID}/packages/generic/releases`;

export class UpdateService {
  private isCheckingForUpdates = false;
  private send: (channel: string, ...args: unknown[]) => boolean;
  private latestUpdateInfo: UpdateInfo | null = null;

  constructor(getMainWindow: () => BrowserWindow | null) {
    this.send = createSender(getMainWindow);
    this.configureUpdater();
    logger.info('UpdateService initialized (Squirrel-native)');
  }

  private configureUpdater(): void {
    if (process.platform !== 'win32') {
      logger.info('Squirrel auto-updater only available on Windows');
      return;
    }

    autoUpdater.on('checking-for-update', () => {
      logger.info('Squirrel checking for updates...');
    });

    autoUpdater.on('update-available', () => {
      logger.info('Squirrel: update available');
      if (this.latestUpdateInfo) {
        this.emitUpdateAvailable(this.latestUpdateInfo);
      }
    });

    autoUpdater.on('update-not-available', () => {
      logger.info('Squirrel: no updates available');
    });

    autoUpdater.on('update-downloaded', (_event, releaseNotes, releaseName, _releaseDate, _updateURL) => {
      logger.info('Squirrel: update downloaded', { releaseName });
      if (this.latestUpdateInfo) {
        this.latestUpdateInfo.releaseNotes = releaseNotes || undefined;
      }
      this.emitDownloaded();
    });

    autoUpdater.on('error', (error) => {
      const msg = error?.message || '';
      if (msg.includes('404') || msg.includes('RELEASES')) {
        logger.info('No Squirrel updates available (RELEASES not found)');
      } else {
        logger.error('Squirrel update error', error);
      }
    });

    logger.info('Squirrel auto-updater configured', {
      currentVersion: app.getVersion(),
    });
  }

  private async fetchLatestReleaseTag(): Promise<string | null> {
    return new Promise((resolve) => {
      const request = net.request({ method: 'GET', url: RELEASES_API });

      const updateToken = process.env.GITLAB_UPDATE_TOKEN;
      if (updateToken) {
        request.setHeader('Private-Token', updateToken);
      }

      let responseData = '';

      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          logger.warn('Failed to fetch releases', { statusCode: response.statusCode });
          resolve(null);
          return;
        }

        response.on('data', (chunk) => {
          responseData += chunk.toString();
        });

        response.on('end', () => {
          try {
            const releases = JSON.parse(responseData);
            if (Array.isArray(releases) && releases.length > 0) {
              const latestRelease = releases[0];
              const tagName = latestRelease.tag_name;
              logger.info('Found latest release', { tagName, name: latestRelease.name });
              resolve(tagName);
            } else {
              logger.info('No releases found');
              resolve(null);
            }
          } catch (error) {
            logger.error('Failed to parse releases response', error);
            resolve(null);
          }
        });
      });

      request.on('error', (error) => {
        logger.error('Failed to fetch releases', error);
        resolve(null);
      });

      request.end();
    });
  }

  private compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;
      if (p1 < p2) return -1;
      if (p1 > p2) return 1;
    }
    return 0;
  }

  async checkForUpdates(): Promise<UpdateInfo | null> {
    if (process.platform !== 'win32') {
      logger.info('Auto-update check skipped (not Windows)');
      return null;
    }

    if (this.isCheckingForUpdates) {
      logger.warn('Already checking for updates');
      return null;
    }

    this.isCheckingForUpdates = true;

    try {
      const latestTag = await this.fetchLatestReleaseTag();
      if (!latestTag) {
        logger.info('No releases found on GitLab');
        return null;
      }

      const latestVersion = latestTag.startsWith('v') ? latestTag.slice(1) : latestTag;
      const currentVersion = app.getVersion();

      if (this.compareVersions(currentVersion, latestVersion) >= 0) {
        logger.info('Already on latest version', { currentVersion, latestVersion });
        return null;
      }

      // Point Squirrel at the version's package directory containing RELEASES + nupkg
      const feedUrl = `${PACKAGES_API}/${latestVersion}`;
      logger.info('Setting Squirrel feed URL', { feedUrl, latestTag });

      this.latestUpdateInfo = {
        version: latestVersion,
        releaseDate: new Date().toISOString(),
      };

      autoUpdater.setFeedURL({ url: feedUrl });
      autoUpdater.checkForUpdates();

      return this.latestUpdateInfo;
    } catch (error) {
      logger.error('Failed to check for updates', error);
      return null;
    } finally {
      this.isCheckingForUpdates = false;
    }
  }

  /**
   * Download the available update.
   * With Squirrel, download starts automatically after checkForUpdates finds one.
   * This method is kept for API compatibility but is a no-op.
   */
  async downloadUpdate(): Promise<void> {
    logger.info('Squirrel handles download automatically after check');
  }

  installUpdate(): void {
    logger.info('Installing update and restarting via Squirrel');
    autoUpdater.quitAndInstall();
  }

  private emitUpdateAvailable(info: UpdateInfo): void {
    this.send(IPC_CHANNELS.UPDATE_AVAILABLE, info);
  }

  private emitDownloaded(): void {
    this.send(IPC_CHANNELS.UPDATE_DOWNLOADED);
  }
}

export default UpdateService;
