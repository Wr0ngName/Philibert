/**
 * Auto-update service using electron-updater with NSIS installer
 *
 * 1. Query GitLab Releases API to find the latest release tag
 * 2. Point electron-updater at that version's package directory
 * 3. electron-updater downloads the NSIS Setup exe and runs it silently
 */

import { BrowserWindow, app, net } from 'electron';
import { autoUpdater, UpdateInfo as ElectronUpdateInfo, UpdateDownloadedEvent } from 'electron-updater';

import { IPC_CHANNELS, UpdateChannel, UpdateInfo, UpdateInstallResult, UpdateProgress } from '../../shared/types';
import { createSender } from '../utils/ipc-helpers';
import logger from '../utils/logger';
import { compareVersions, isPrerelease, parseVersion } from '../utils/version';

import type ConfigService from './ConfigService';

const GITLAB_HOST = 'https://dev.web.wr0ng.name';
const GITLAB_PROJECT_ID = 'wrongname%2Fphilibert';

const RELEASES_API = `${GITLAB_HOST}/api/v4/projects/${GITLAB_PROJECT_ID}/releases`;
/** A release's page, where its packages can be downloaded by hand. */
const RELEASE_PAGE = (tag: string): string => `${GITLAB_HOST}/wrongname/philibert/-/releases/${tag}`;

/**
 * The command that installs a downloaded Linux package by hand, in a
 * terminal, where sudo asks for the password itself — for when the updater
 * could not get the password asked for (pkexec finds no polkit agent for the
 * app's process). Null for anything else, such as the Windows installer.
 */
export function manualInstallCommand(file: string): string | null {
  const quoted = `'${file.replace(/'/g, `'\\''`)}'`;
  if (file.endsWith('.deb')) return `sudo apt install ${quoted}`;
  if (file.endsWith('.rpm')) return `sudo dnf install ${quoted}`;
  return null;
}
const PACKAGES_API = `${GITLAB_HOST}/api/v4/projects/${GITLAB_PROJECT_ID}/packages/generic/releases`;

export class UpdateService {
  private isCheckingForUpdates = false;
  /** The release the last check offered, for its page when installing fails. */
  private offeredTag: string | null = null;
  /** Where the update was downloaded to, to install it by hand when the installer fails. */
  private downloadedFile: string | null = null;
  private send: (channel: string, ...args: unknown[]) => boolean;
  private configService: ConfigService;

  constructor(getMainWindow: () => BrowserWindow | null, configService: ConfigService) {
    this.send = createSender(getMainWindow);
    this.configService = configService;
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
    // Into main.log. Left to its default, electron-updater logs to the
    // console, which no installed app has: the command an install ran, and
    // what it printed when it failed, were lost.
    autoUpdater.logger = logger;

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

    autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
      this.downloadedFile = event.downloadedFile;
      logger.info('Update downloaded', { downloadedFile: event.downloadedFile });
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

  private async fetchLatestReleaseTag(channel: UpdateChannel): Promise<string | null> {
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
            if (!Array.isArray(releases) || releases.length === 0) {
              logger.info('No releases found');
              resolve(null);
              return;
            }

            const bestTag = this.findBestRelease(releases, channel);
            if (bestTag) {
              logger.info('Found latest release for channel', { channel, tagName: bestTag });
            } else {
              logger.info('No matching release found for channel', { channel });
            }
            resolve(bestTag);
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

  private findBestRelease(releases: Array<{ tag_name: string }>, channel: UpdateChannel): string | null {
    let bestTag: string | null = null;

    for (const release of releases) {
      const tag = release.tag_name;
      try {
        parseVersion(tag);
      } catch {
        continue;
      }

      if (channel === 'stable' && isPrerelease(tag)) {
        continue;
      }

      if (bestTag === null || compareVersions(tag, bestTag) > 0) {
        bestTag = tag;
      }
    }

    return bestTag;
  }

  async checkForUpdates(): Promise<UpdateInfo | null> {
    if (this.isCheckingForUpdates) {
      logger.warn('Already checking for updates');
      return null;
    }

    this.isCheckingForUpdates = true;

    try {
      const channel = await this.configService.getUpdateChannel();
      const latestTag = await this.fetchLatestReleaseTag(channel);
      if (!latestTag) {
        logger.info('No releases found on GitLab', { channel });
        return null;
      }

      const latestVersion = latestTag.startsWith('v') ? latestTag.slice(1) : latestTag;
      const currentVersion = app.getVersion();

      if (compareVersions(currentVersion, latestVersion) >= 0) {
        logger.info('Already on latest version', { currentVersion, latestVersion, channel });
        return null;
      }

      this.offeredTag = latestTag;
      const feedUrl = `${PACKAGES_API}/${latestVersion}`;
      logger.info('Setting feed URL for update check', { feedUrl, latestTag, channel });

      autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });

      const result = await autoUpdater.checkForUpdates();

      // electron-updater answers null, rather than failing, when it does not
      // update this kind of install — on Linux, one it takes for an AppImage
      // and finds is not (see resources/linux/postinst).
      if (result === null) {
        logger.warn('The updater is not active for this install', {
          platform: process.platform,
          latestVersion,
        });
        return null;
      }

      if (result.updateInfo) {
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
        // The release exists — it was found above — so what is missing is
        // its feed for this platform (latest.yml, or latest-linux.yml).
        logger.warn('The release has no update feed for this platform', {
          platform: process.platform,
          error: errorMessage,
        });
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

  /**
   * Install the downloaded update; the app quits to let it finish.
   *
   * electron-updater does not throw when the install fails: it reports an
   * `error` event during the call and the app stays open, so the button
   * that asked for it looked like it did nothing. The error is caught here
   * and handed back, with the release's page to download it from by hand.
   */
  installUpdate(): UpdateInstallResult {
    logger.info('Installing update and restarting');
    let failure: Error | null = null;
    const onError = (error: Error) => { failure = error; };
    autoUpdater.on('error', onError);
    try {
      autoUpdater.quitAndInstall();
    } finally {
      autoUpdater.removeListener('error', onError);
    }
    if (failure === null) return { installed: true };
    const error = (failure as Error).message;
    logger.error('The update could not be installed', {
      error, tag: this.offeredTag, downloadedFile: this.downloadedFile,
    });
    return {
      installed: false,
      error,
      downloadedFile: this.downloadedFile,
      installCommand: this.downloadedFile ? manualInstallCommand(this.downloadedFile) : null,
      releaseUrl: this.offeredTag ? RELEASE_PAGE(this.offeredTag) : null,
    };
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
