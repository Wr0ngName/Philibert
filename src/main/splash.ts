import path from 'node:path';

import { BrowserWindow } from 'electron';

import { debugLog as debugLogBase } from './utils/debugLog';

function debugLog(message: string): void {
  debugLogBase(message, 'splash');
}

let splashWindow: BrowserWindow | null = null;

/**
 * The splash window: at startup, and while closing waits for saves.
 *
 * `status` is shown from the start, in the page's address: a status sent
 * before the page has loaded is not received.
 */
export function createSplashWindow(status?: string): BrowserWindow {
  debugLog('Creating splash window');

  splashWindow = new BrowserWindow({
    width: 320,
    height: 280,
    frame: false,
    resizable: false,
    movable: false,
    center: true,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#6d28d9',
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  splashWindow.loadFile(path.join(__dirname, 'splash.html'), status ? { query: { status } } : undefined);

  splashWindow.once('ready-to-show', () => {
    debugLog('Splash window ready-to-show');
    splashWindow?.show();
  });

  splashWindow.on('closed', () => {
    debugLog('Splash window closed');
    splashWindow = null;
  });

  return splashWindow;
}

export function updateSplashStatus(message: string): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash-status', message);
  }
}

export function updateSplashVersion(version: string): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash-version', version);
  }
}

export function closeSplashWindow(): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    debugLog('Closing splash window');
    splashWindow.close();
    splashWindow = null;
  }
}
