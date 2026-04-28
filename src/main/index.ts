/**
 * Main process entry point for Cline GUI
 */

import { debugLog } from './utils/debugLog';

debugLog('=== App starting ===');
debugLog(`process.execPath: ${process.execPath}`);
debugLog(`process.argv: ${JSON.stringify(process.argv)}`);
debugLog(`process.cwd(): ${process.cwd()}`);
debugLog(`__dirname: ${__dirname}`);

// Only NOW dynamically import everything else - this runs at runtime, not module load time
async function main(): Promise<void> {
  debugLog('main() started');

  // Dynamic imports - these happen AFTER the Squirrel check above
  debugLog('Importing electron...');
  const { app, BrowserWindow, dialog } = await import('electron');
  debugLog('Importing ipc...');
  const { setupIPC } = await import('./ipc');
  debugLog('Importing AuthService...');
  const { default: AuthService } = await import('./services/AuthService');
  debugLog('Importing ClaudeCodeService...');
  const { default: ClaudeCodeService } = await import('./services/ClaudeCodeService');
  debugLog('Importing ConfigService...');
  const { default: ConfigService } = await import('./services/ConfigService');
  debugLog('Importing ConversationService...');
  const { default: ConversationService } = await import('./services/ConversationService');
  debugLog('Importing FileWatcherService...');
  const { default: FileWatcherService } = await import('./services/FileWatcherService');
  debugLog('Importing GitService...');
  const { default: GitService } = await import('./services/GitService');
  debugLog('Importing NotificationService...');
  const { default: NotificationService } = await import('./services/NotificationService');
  debugLog('Importing UpdateService...');
  const { default: UpdateService } = await import('./services/UpdateService');
  debugLog('Importing logger...');
  const { default: logger } = await import('./utils/logger');
  debugLog('Importing window...');
  const { createWindow, getMainWindow } = await import('./window');
  debugLog('All imports completed');

  // Service instances
  let authService: InstanceType<typeof AuthService>;
  let configService: InstanceType<typeof ConfigService>;
  let notificationService: InstanceType<typeof NotificationService>;
  let claudeService: InstanceType<typeof ClaudeCodeService>;
  let fileWatcher: InstanceType<typeof FileWatcherService>;
  let gitService: InstanceType<typeof GitService>;
  let conversationService: InstanceType<typeof ConversationService>;
  let updateService: InstanceType<typeof UpdateService>;

  // IPC cleanup function - stored to call on app quit
  let ipcCleanup: (() => void) | null = null;

  /**
   * Initialize all services
   */
  async function initializeServices(): Promise<void> {
    logger.info('Initializing services...');

    configService = new ConfigService();
    await configService.ensureInitialized();

    authService = new AuthService();
    notificationService = new NotificationService(configService, getMainWindow);
    claudeService = new ClaudeCodeService(configService, getMainWindow, notificationService);
    fileWatcher = new FileWatcherService();
    gitService = new GitService();
    conversationService = new ConversationService();
    updateService = new UpdateService(getMainWindow);

    logger.info('All services initialized');
  }

  /**
   * Application ready handler
   */
  async function onReady(): Promise<void> {
    debugLog('onReady() called');
    try {
      logger.info('Application ready');
      debugLog('Calling initializeServices()...');

      await initializeServices();
      debugLog('Services initialized');

      debugLog('Setting up IPC...');
      ipcCleanup = setupIPC(
        {
          authService,
          configService,
          claudeService,
          fileWatcher,
          gitService,
          conversationService,
          updateService,
        },
        getMainWindow
      );
      debugLog('IPC setup complete');

      debugLog('Creating window...');
      const config = await configService.getConfig();
      const mainWindow = await createWindow({ logLevel: config.logLevel });
      debugLog(`Window created: ${mainWindow ? 'success' : 'null'}`);

      // Windows: ensure bundled dependencies are ready (download for online, extract git-bash)
      if (process.platform === 'win32') {
        const { setupWindowsDependencies } = await import('./utils/windowsSetup');
        await setupWindowsDependencies(mainWindow);
      }

      const lastWorkingDir = await configService.getWorkingDirectory();
      if (lastWorkingDir) {
        fileWatcher.watch(lastWorkingDir);
        logger.info('Restored working directory', { directory: lastWorkingDir });
      }

      debugLog('onReady() completed successfully');

      setTimeout(() => {
        updateService.checkForUpdates().catch((error: unknown) => {
          logger.warn('Failed to check for updates on startup', error);
        });
      }, 5000);
    } catch (error) {
      debugLog(`onReady() ERROR: ${error instanceof Error ? error.stack : String(error)}`);
      logger.error('Critical error during app startup:', error);
      dialog.showErrorBox(
        'Startup Error',
        `Cline GUI failed to start: ${error instanceof Error ? error.message : String(error)}`
      );
      app.quit();
    }
  }

  // Set up app event handlers
  debugLog('Setting up app event handlers...');
  app.on('ready', onReady);

  app.on('window-all-closed', () => {
    debugLog('window-all-closed event');
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    debugLog('activate event');
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  app.on('before-quit', () => {
    debugLog('before-quit event');
    logger.info('Application quitting');

    // Clean up all resources
    gitService?.stopWatching();
    fileWatcher?.stop();

    if (ipcCleanup) {
      ipcCleanup();
      ipcCleanup = null;
    }

    // Clean up any pending OAuth flows
    authService?.cleanupOAuthFlow();
  });

  process.on('uncaughtException', (error) => {
    debugLog(`uncaughtException: ${error instanceof Error ? error.stack : String(error)}`);
    logger.error('Uncaught exception', error);
  });

  process.on('unhandledRejection', (reason) => {
    debugLog(`unhandledRejection: ${reason}`);
    logger.error('Unhandled rejection', reason);
  });

  debugLog('Event handlers set up, app is running');
  logger.info('Main process started', {
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
  });
}

// Start the application
main().catch((error) => {
  debugLog(`main() FATAL ERROR: ${error instanceof Error ? error.stack : String(error)}`);
  console.error('Fatal error starting application:', error);
  process.exit(1);
});
