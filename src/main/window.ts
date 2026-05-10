/**
 * Window management for the main application window
 */

import * as fs from 'node:fs';
import path from 'node:path';

import { BrowserWindow, shell } from 'electron';

import type { LogLevel } from '../shared/types';

import { MAIN_CONSTANTS } from './constants/app';
import { debugLog as debugLogBase } from './utils/debugLog';
import logger from './utils/logger';

/** Debug log with 'window' context */
function debugLog(message: string): void {
  debugLogBase(message, 'window');
}

let mainWindow: BrowserWindow | null = null;

// Declare the Vite dev server URL (provided by Electron Forge)
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

export interface WindowOptions {
  logLevel?: LogLevel;
}

/**
 * Create the main application window
 */
export async function createWindow(options: WindowOptions = {}): Promise<BrowserWindow> {
  debugLog('createWindow() called');
  logger.info('Creating main window');

  const preloadPath = path.join(__dirname, 'preload.js');
  debugLog(`Preload path: ${preloadPath}`);
  debugLog(`Preload exists: ${fs.existsSync(preloadPath)}`);

  // Show title bar and menu bar only in debug mode
  const isDebugMode = options.logLevel === 'debug';
  debugLog(`Debug mode: ${isDebugMode}, logLevel: ${options.logLevel}`);

  mainWindow = new BrowserWindow({
    width: MAIN_CONSTANTS.WINDOW.DEFAULT_WIDTH,
    height: MAIN_CONSTANTS.WINDOW.DEFAULT_HEIGHT,
    minWidth: MAIN_CONSTANTS.WINDOW.MIN_WIDTH,
    minHeight: MAIN_CONSTANTS.WINDOW.MIN_HEIGHT,
    title: 'Philibert',
    backgroundColor: '#fafafa',
    show: false, // Don't show until ready
    frame: isDebugMode, // Hide title bar unless debug mode
    autoHideMenuBar: !isDebugMode, // Hide menu bar unless debug mode
    titleBarStyle: isDebugMode ? 'default' : 'hidden',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Required for some Electron features
    },
  });
  debugLog('BrowserWindow created');

  // Load the app
  try {
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      debugLog(`Loading from dev server: ${MAIN_WINDOW_VITE_DEV_SERVER_URL}`);
      logger.info('Loading from dev server:', MAIN_WINDOW_VITE_DEV_SERVER_URL);
      await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    } else {
      const indexPath = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
      debugLog(`Loading from file: ${indexPath}`);
      debugLog(`Index file exists: ${fs.existsSync(indexPath)}`);
      logger.info('Loading from file:', indexPath);
      await mainWindow.loadFile(indexPath);
    }
    debugLog('Content loaded successfully');
  } catch (error) {
    debugLog(`Failed to load content: ${error instanceof Error ? error.stack : String(error)}`);
    logger.error('Failed to load main window content:', error);
    // Show window anyway so user can see something went wrong
    mainWindow.show();
    return mainWindow;
  }

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    debugLog('ready-to-show event fired');
    mainWindow?.show();
    debugLog('Window shown');
    logger.info('Main window ready and shown');
  });

  // Fallback: show window after timeout if ready-to-show doesn't fire
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      debugLog('Timeout: window not visible, forcing show');
      logger.warn('Window not shown after timeout, forcing show');
      mainWindow.show();
    }
  }, MAIN_CONSTANTS.WINDOW.SHOW_TIMEOUT_MS);

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Open DevTools in debug mode
  if (isDebugMode) {
    debugLog('Opening DevTools (debug mode)');
    mainWindow.webContents.openDevTools();
  }

  // Handle window close
  mainWindow.on('closed', () => {
    debugLog('Window closed event');
    mainWindow = null;
    logger.info('Main window closed');
  });

  debugLog('createWindow() returning');
  return mainWindow;
}

/**
 * Get the main window instance
 */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * Minimize the window
 */
export function minimizeWindow(): void {
  mainWindow?.minimize();
}

/**
 * Maximize or restore the window
 */
export function maximizeWindow(): void {
  if (mainWindow?.isMaximized()) {
    mainWindow.restore();
  } else {
    mainWindow?.maximize();
  }
}

/**
 * Close the window
 */
export function closeWindow(): void {
  mainWindow?.close();
}
