/**
 * Auto-update service using electron-updater with NSIS installer
 *
 * 1. Query GitLab Releases API to find the latest release tag
 * 2. Point electron-updater at that version's package directory
 * 3. electron-updater downloads the NSIS Setup exe and runs it silently
 */

import { BrowserWindow, app, net } from 'electron';
import { autoUpdater, UpdateInfo as ElectronUpdateInfo } from 'electron-updater';

import { IPC_CHANNELS, UpdateInfo, UpdateProgress } from '../../shared/types';
import { createSender } from '../utils/ipc-helpers';
import logger from '../utils/logger';

const GITLAB_HOST = 'https://dev.web.wr0ng.name';
const GITLAB_PROJECT_ID = 'wrongname%2Fphilibert';

const RELEASES_API = `${GITLAB_HOST}/api/v4/projects/${GITLAB_PROJECT_ID}/releases`;
const PACKAGES_API = `${GITLAB_HOST}/api/v4/projects/${GITLAB_PROJECT_ID}/packages/generic/releases`;

export class UpdateService {
  private isCheckingForUpdates = false;
  private send: (channel: string, ...args: unknown[]) => boolean;

  constructor(getMainWindow: () => BrowserWindow | null) {
    this.send = createSender(getMainWindow);
    this.configureUpdater();
    logger.info('UpdateService initialized');
  }

  private configureUpdater(): void {
    const currentVersion = app.getVersion();

    autoUpdater.setFeedURL({
      provider: 'generic',
      url: `${PACKAGES_API}/${currentVersion}`,
    });

    const updateToken = process.env.GITLAB_UPDATE_TOKEN;
    if (updateToken) {
      autoUpdater.requestHeaders = { 'Private-Token': updateToken };
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
      logger.info('Checking for updates...');
    });

    autoUpdater.on('update-available', (info: ElectronUpdateInfo) => {
      logger.info('Update available', { version: info.version });
      this.emitUpdateAvailable({
        version: info.version,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
        releaseDate: info.releaseDate,
      });
    });

    autoUpdater.on('update-not-available', () => {
      logger.info('No updates available');
    });

    autoUpdater.on('download-progress', (progress) => {
      logger.debug('Download progress', { percent: progress.percent });
      this.emitProgress({
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        total: progress.total,
        transferred: progress.transferred,
      });
    });

    autoUpdater.on('update-downloaded', () => {
      logger.info('Update downloaded');
      this.emitDownloaded();
    });

    autoUpdater.on('error', (error) => {
      const errorMessage = error?.message || '';
      if (errorMessage.includes('404') || errorMessage.includes('Cannot find channel')) {
        logger.info('No updates available (404 - no releases published yet)');
      } else {
        logger.error('Update error', error);
      }
    });

    logger.info('Auto-updater configured', { currentVersion, hasAuth: !!updateToken });
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

      const feedUrl = `${PACKAGES_API}/${latestVersion}`;
      logger.info('Setting feed URL for update check', { feedUrl, latestTag });

      autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });

      const result = await autoUpdater.checkForUpdates();

      if (result?.updateInfo) {
        return {
          version: result.updateInfo.version,
          releaseNotes:
            typeof result.updateInfo.releaseNotes === 'string'
              ? result.updateInfo.releaseNotes
              : undefined,
          releaseDate: result.updateInfo.releaseDate,
        };
      }

      return null;
    } catch (error) {
      const errorMessage = (error as Error)?.message || '';
      if (errorMessage.includes('404') || errorMessage.includes('Cannot find channel')) {
        logger.info('No releases published to package registry yet');
        return null;
      }
      logger.error('Failed to check for updates', error);
      return null;
    } finally {
      this.isCheckingForUpdates = false;
    }
  }

  async downloadUpdate(): Promise<void> {
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      logger.error('Failed to download update', error);
      throw error;
    }
  }

  installUpdate(): void {
    logger.info('Installing update and restarting');
    autoUpdater.quitAndInstall();
  }

  private emitUpdateAvailable(info: UpdateInfo): void {
    this.send(IPC_CHANNELS.UPDATE_AVAILABLE, info);
  }

  private emitProgress(progress: UpdateProgress): void {
    this.send(IPC_CHANNELS.UPDATE_PROGRESS, progress);
  }

  private emitDownloaded(): void {
    this.send(IPC_CHANNELS.UPDATE_DOWNLOADED);
  }
}

export default UpdateService;
