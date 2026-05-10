/**
 * Debug logging utility for early startup and Squirrel events.
 *
 * Uses ONLY Node built-ins, safe to use before Electron is fully loaded.
 * Writes to a file in the temp directory for debugging startup issues.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Path to the debug log file in the system temp directory */
export const DEBUG_LOG_PATH = path.join(os.tmpdir(), 'philibert-debug.log');

/**
 * Write a debug message to the file-based log.
 * Used for early startup logging before electron-log is available.
 *
 * @param message - The message to log
 * @param context - Optional context identifier (e.g., 'window', 'main')
 */
export function debugLog(message: string, context?: string): void {
  const timestamp = new Date().toISOString();
  const prefix = context ? ` [${context}]` : '';
  const line = `[${timestamp}]${prefix} ${message}\n`;
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, line);
  } catch {
    // Ignore write errors - this is best-effort debug logging
  }
}
