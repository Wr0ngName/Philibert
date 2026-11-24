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

  // Emitted as .cjs (Electron Forge 8's Vite plugin), as the main bundle is.
  const preloadPath = path.join(__dirname, 'preload.cjs');
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
  installAttentionFlash(mainWindow);

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

/** What closing shows while it waits for saves; see installCloseGuard. */
export interface SavingScreen {
  show(message: string): void;
  hide(): void;
}

export const CLOSE_SAVING_MESSAGE = 'Saving your discussions before closing…';
export const UPDATE_SAVING_MESSAGE = 'Saving your discussions before updating…';

/** What the app is left for: quitting, or restarting to install an update. */
type Leaving = 'quit' | 'update';

/** The guard's hold on the app's leaving, for what leaves it other than closing the window. */
export interface CloseGuard {
  /**
   * Make ready to quit for an update, before it is installed: asked about as
   * closing is when work is in flight — the installer quits the app, which
   * stops it — then the discussions saved, as the installer may end the app
   * without waiting for closing to save them. True once ready: the close
   * the install brings is not asked about again. False when the user keeps
   * working: nothing is to be installed.
   */
  prepareToQuitForUpdate(): Promise<boolean>;
  /** The install did not quit the app after all: closing is asked about again. */
  quitForUpdateAbandoned(): void;
}

/**
 * Ask before closing while work is in flight.
 *
 * Quitting ends the SDK sessions, so a turn mid-answer and any background task
 * it started are lost with no way to resume them — and nothing previously said
 * so. The prompt only appears when there is something to lose, so the ordinary
 * close stays a single click. Restarting to install an update quits as well,
 * and is asked about the same way (prepareToQuitForUpdate) — before the
 * install, which comes before the quit: electron-updater installs (.deb) or
 * starts the installer (NSIS), then quits.
 *
 * `close` is emitted again after the user confirms, which is why the decision
 * is latched: without that the dialog would reappear forever.
 *
 * Closing then waits for two things in turn: the renderer handing over what
 * it has (`flushRenderer`), and the main process writing it (`settleWrites`).
 * The second is waited for even when the first gave up or failed — a save
 * the renderer sent is still being written. On 2026-11-09 the close stopped
 * waiting for the renderer after 5 seconds, while the main process was one
 * second into rewriting a discussion: the process ended and the file was cut.
 */
export function installCloseGuard(
  window: BrowserWindow,
  getRunningWork: () => { turns: number; tasks: number },
  flushRenderer: () => Promise<void>,
  settleWrites: () => Promise<unknown>,
  savingScreen: SavingScreen,
): CloseGuard {
  /** The window is closing, as confirmed: its `close` again goes through. */
  let closing = false;
  /** Leaving for an update was confirmed: its close is not asked about again. */
  let leavingConfirmed = false;

  /** What would be lost, or null when nothing; never trapping the user when this cannot be told. */
  function runningWork(): string | null {
    try {
      return describeRunningWork(getRunningWork());
    } catch (error) {
      // Never trap the user in the app because the check itself failed.
      logger.warn('Could not determine running work on close', { error });
      return null;
    }
  }

  /** Whether to go ahead and leave: asked only with work in flight. */
  async function confirmLeaving(leaving: Leaving): Promise<boolean> {
    const summary = runningWork();
    if (!summary) return true;
    logger.info('Leaving held pending confirmation', { leaving, summary });
    const stops = `${summary.includes(' and ') ? 'them' : 'it'}`;
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        buttons: ['Keep working', leaving === 'quit' ? 'Quit anyway' : 'Restart anyway'],
        defaultId: 0,
        cancelId: 0,
        title: 'Work still in progress',
        message: leaving === 'quit' ? 'Quit Philibert?' : 'Restart Philibert to update?',
        detail: leaving === 'quit'
          ? `${summary}. Quitting stops ${stops}.`
          : `${summary}. Restarting to install the update stops ${stops}.`,
      });
      return response === 1;
    } catch (error) {
      logger.error('Close confirmation dialog failed', { error });
      return false;
    }
  }

  /** Save what the renderer holds and what is being written, said on screen once it is not instant. */
  async function save(message: string): Promise<void> {
    // Said on screen once it is not instant, so a slow save is not taken
    // for a hang and the app killed in the middle of it.
    let shown = false;
    const timer = setTimeout(() => {
      shown = true;
      savingScreen.show(message);
    }, MAIN_CONSTANTS.WINDOW.CLOSE_SAVING_SCREEN_DELAY_MS);
    try {
      await flushRenderer();
    } catch (error) {
      // A renderer that cannot save must not become a window that cannot
      // close. The reason is logged; the close goes ahead.
      logger.error('Pre-close flush failed; closing anyway', { error });
    }
    try {
      await settleWrites();
    } catch (error) {
      logger.error('Waiting for saves before close failed; closing anyway', { error });
    }
    clearTimeout(timer);
    if (shown) savingScreen.hide();
  }

  window.on('close', (event) => {
    if (closing) return;

    // Held open either way: with work running the user is asked first, and
    // with none there is still unsaved state to persist.
    event.preventDefault();

    void (async () => {
      if (!leavingConfirmed && !(await confirmLeaving('quit'))) return;
      closing = true;
      await save(CLOSE_SAVING_MESSAGE);
      window.close();
    })();
  });

  return {
    async prepareToQuitForUpdate() {
      if (!(await confirmLeaving('update'))) return false;
      leavingConfirmed = true;
      await save(UPDATE_SAVING_MESSAGE);
      return true;
    },
    quitForUpdateAbandoned() {
      leavingConfirmed = false;
    },
  };
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

/** Whether something in the window waits on the user: a permission ask or a question. */
let attentionNeeded = false;

/** Flash the window in the taskbar while something waits and the user is elsewhere. */
function updateAttention(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  // A window the user is looking at needs no flashing to be seen.
  window.flashFrame(attentionNeeded && !window.isFocused());
}

/**
 * Say whether something waits on the user. While it does, the window
 * flashes in the taskbar whenever it is not focused — on Windows the button
 * flashes, on Linux the window is marked urgent, which taskbars show, and
 * on macOS the dock icon bounces — and stops once it is focused or nothing
 * waits any more.
 */
export function setAttentionNeeded(needed: boolean, window: BrowserWindow | null = mainWindow): void {
  attentionNeeded = needed;
  if (window) updateAttention(window);
}

/** Keeps the flashing in step with the window's focus. */
export function installAttentionFlash(window: BrowserWindow): void {
  window.on('focus', () => updateAttention(window));
  window.on('blur', () => updateAttention(window));
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
