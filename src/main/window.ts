/**
 * Window management for the main application window
 */

import * as fs from 'node:fs';
import path from 'node:path';

import { BrowserWindow, Menu, dialog, ipcMain, shell, type MenuItemConstructorOptions, type WebContents } from 'electron';

import { IPC_CHANNELS, type LogLevel } from '../shared/types';

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

  installEditingContextMenu(mainWindow.webContents);
  installMediaPermissionHandler(mainWindow);

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
 * Allow the window's own pages to use the microphone, and nothing else.
 *
 * Electron's default permission handler denies media requests, so without
 * this `getUserMedia` rejects and dictation can never start. The grant is
 * deliberately narrow: only the `media` permission, only for audio, and only
 * for content this app loaded itself. Everything else is refused, including
 * video — nothing here needs a camera, and a blanket allow would hand one to
 * any page that found its way into this window.
 */
export function installMediaPermissionHandler(window: BrowserWindow): void {
  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    if (permission !== 'media') {
      callback(false);
      return;
    }

    // mediaTypes is absent on some requests; treat that as "not audio" rather
    // than assuming, so an unexpected shape cannot widen the grant.
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    const audioOnly = mediaTypes.length > 0 && mediaTypes.every((type) => type === 'audio');
    if (!audioOnly) {
      logger.info('Denied media permission request', { permission, mediaTypes });
      callback(false);
      return;
    }

    callback(true);
  });
}

/**
 * Give editable fields a native cut/copy/paste context menu.
 *
 * Electron ships no default context menu. Chromium's belongs to the browser
 * UI layer, which Electron does not provide, so right-clicking a textarea in
 * an Electron app does nothing at all unless the app builds the menu itself —
 * which is why the prompt box had no cut/copy/paste. The keyboard shortcuts
 * worked throughout; only the menu was missing.
 *
 * Restricted to `params.isEditable` on purpose. This event fires even when the
 * renderer called preventDefault on its own `contextmenu` handler, so showing
 * a menu for non-editable content would put this native menu on top of the
 * Vue one MessageItem already renders for messages. Editable fields are the
 * gap, and they are the whole gap.
 *
 * Built from roles so the labels, accelerators and behaviour are the
 * platform's own rather than reimplemented, and gated on `editFlags` so
 * entries that cannot apply are greyed out instead of silently doing nothing.
 */
export function installEditingContextMenu(webContents: WebContents): void {
  webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return;

    const flags = params.editFlags;
    const template: MenuItemConstructorOptions[] = [
      { role: 'undo', enabled: flags.canUndo },
      { role: 'redo', enabled: flags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: flags.canCut },
      { role: 'copy', enabled: flags.canCopy },
      { role: 'paste', enabled: flags.canPaste },
      { role: 'delete', enabled: flags.canDelete },
      { type: 'separator' },
      { role: 'selectAll', enabled: flags.canSelectAll },
    ];

    Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(webContents) ?? undefined });
  });
}

/**
 * Get the main window instance
 */
/**
 * How to describe work that quitting would abandon, or null when there is
 * none.
 *
 * Separated from the dialog so the wording and the decision can be asserted
 * without Electron: whether to warn at all is the part that matters, and it
 * must be silent when nothing is running.
 */
export function describeRunningWork(work: { turns: number; tasks: number }): string | null {
  const parts: string[] = [];
  if (work.turns > 0) {
    parts.push(`${work.turns} conversation${work.turns === 1 ? '' : 's'} still working`);
  }
  if (work.tasks > 0) {
    parts.push(`${work.tasks} background task${work.tasks === 1 ? '' : 's'} still running`);
  }
  return parts.length > 0 ? parts.join(' and ') : null;
}

/**
 * Ask before closing while work is in flight.
 *
 * Quitting ends the SDK sessions, so a turn mid-answer and any background task
 * it started are lost with no way to resume them — and nothing previously said
 * so. The prompt only appears when there is something to lose, so the ordinary
 * close stays a single click.
 *
 * `close` is emitted again after the user confirms, which is why the decision
 * is latched: without that the dialog would reappear forever.
 */
export function installCloseGuard(
  window: BrowserWindow,
  getRunningWork: () => { turns: number; tasks: number },
  flushRenderer: () => Promise<void>,
): void {
  let closing = false;

  window.on('close', (event) => {
    if (closing) return;

    let summary: string | null;
    try {
      summary = describeRunningWork(getRunningWork());
    } catch (error) {
      // Never trap the user in the app because the check itself failed.
      logger.warn('Could not determine running work on close', { error });
      summary = null;
    }

    // Held open either way: with work running the user is asked first, and
    // with none there is still unsaved state to persist.
    event.preventDefault();

    const proceed = async () => {
      closing = true;
      try {
        await flushRenderer();
      } catch (error) {
        // A renderer that cannot save must not become a window that cannot
        // close. The reason is logged; the close goes ahead.
        logger.error('Pre-close flush failed; closing anyway', { error });
      }
      window.close();
    };

    if (!summary) {
      void proceed();
      return;
    }

    logger.info('Close blocked pending confirmation', { summary });

    void dialog
      .showMessageBox(window, {
        type: 'warning',
        buttons: ['Keep working', 'Quit anyway'],
        defaultId: 0,
        cancelId: 0,
        title: 'Work still in progress',
        message: 'Quit Philibert?',
        detail: `${summary}. Quitting stops ${summary.includes(' and ') ? 'them' : 'it'}.`,
      })
      .then(({ response }) => {
        if (response !== 1) return;
        void proceed();
      })
      .catch((error) => {
        logger.error('Close confirmation dialog failed', { error });
      });
  });
}

/**
 * Ask the renderer to persist everything, and wait — but not forever.
 *
 * The renderer saves from `onUnmounted`, which is not a reliable hook for a
 * window closing: the close is not held open for it, so a save still in
 * flight is simply abandoned. Requesting it explicitly and holding the close
 * until the renderer answers is the difference between hoping and knowing.
 *
 * Bounded, because a renderer that never answers — a crash, a breakpoint, a
 * save wedged on a slow disk — must not leave a window that cannot be closed.
 * Giving up loses at most what that save would have written, which is the
 * situation before this existed.
 */
export function requestRendererFlush(
  window: BrowserWindow,
  timeoutMs: number = MAIN_CONSTANTS.WINDOW.CLOSE_FLUSH_TIMEOUT_MS,
): Promise<void> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (reason: string) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener(IPC_CHANNELS.WINDOW_FLUSH_COMPLETE, onComplete);
      clearTimeout(timer);
      logger.info('Pre-close flush finished', { reason });
      resolve();
    };

    const onComplete = () => finish('renderer reported done');
    const timer = setTimeout(() => finish('timed out waiting for the renderer'), timeoutMs);

    ipcMain.once(IPC_CHANNELS.WINDOW_FLUSH_COMPLETE, onComplete);
    window.webContents.send(IPC_CHANNELS.WINDOW_FLUSH_BEFORE_CLOSE);
  });
}

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
