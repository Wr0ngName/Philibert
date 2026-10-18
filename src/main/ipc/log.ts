/**
 * IPC handler writing renderer warnings and errors to main.log.
 *
 * The renderer's own console is only visible with devtools open, so a failure
 * that happened entirely in the renderer left nothing behind in the log a user
 * can send — a send with a picture threw before main ever saw it, and the log
 * showed no error at all.
 */

import { ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../shared/types';
import logger from '../utils/logger';

/**
 * Longest message and data written per line. A renderer error inside a loop
 * can repeat as fast as it renders; the caps keep each line to a size that
 * says what happened without one bad payload filling the file.
 */
export const RENDERER_LOG_LIMITS = { message: 2_000, data: 16_000 } as const;

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}… [${text.length - limit} more chars]` : text;
}

export function setupLogIPC(): void {
  // `on`, not `handle`: logging is fire and forget, and a renderer must never
  // wait on — or fail because of — writing a log line.
  ipcMain.on(IPC_CHANNELS.LOG_WRITE, (_event, entry: unknown) => {
    // From the renderer, so checked rather than trusted.
    if (typeof entry !== 'object' || entry === null) return;
    const { level, message, data } = entry as Record<string, unknown>;
    if (level !== 'warn' && level !== 'error') return;
    if (typeof message !== 'string') return;

    const line = `[renderer] ${clip(message, RENDERER_LOG_LIMITS.message)}`;
    if (typeof data === 'string' && data.length > 0) {
      logger[level](line, clip(data, RENDERER_LOG_LIMITS.data));
    } else {
      logger[level](line);
    }
  });

  logger.info('Log IPC handlers registered');
}
