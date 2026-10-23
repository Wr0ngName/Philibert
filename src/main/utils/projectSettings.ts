/**
 * Read and write a project's Claude Code settings files.
 *
 *   <project>/.claude/settings.json        shared, usually committed
 *   <project>/.claude/settings.local.json  per-user, git-ignored
 *
 * Both files belong to the user and may hold keys we know nothing about, so
 * callers mutate the parsed original and write it back whole.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { ConfigurationError, ERROR_CODES } from '../errors';

/** Absolute path of the project's `.claude/settings.local.json`. */
export function getLocalSettingsPath(workingDirectory: string): string {
  return path.join(workingDirectory, '.claude', 'settings.local.json');
}

/** Absolute path of the project's `.claude/settings.json`. */
export function getSharedSettingsPath(workingDirectory: string): string {
  return path.join(workingDirectory, '.claude', 'settings.json');
}

/**
 * Parse a JSON file, treating "missing" as "empty".
 *
 * A file that exists but does not parse is an error: overwriting it would
 * destroy hand-written configuration, so the user is told to fix it instead.
 */
export function readJsonFile<T extends object>(filePath: string): T {
  if (!fs.existsSync(filePath)) return {} as T;

  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw new ConfigurationError(
      `Could not read ${path.basename(filePath)}.`,
      ERROR_CODES.CONFIG_LOAD_FAILED,
      error
    );
  }

  if (text.trim().length === 0) return {} as T;

  try {
    const parsed = JSON.parse(text);
    return (parsed && typeof parsed === 'object' ? parsed : {}) as T;
  } catch (error) {
    throw new ConfigurationError(
      `${path.basename(filePath)} is not valid JSON, so Philibert will not overwrite it. ` +
        `Fix or delete the file at ${filePath} and try again.`,
      ERROR_CODES.CONFIG_INVALID,
      error
    );
  }
}

export function writeJsonFile(filePath: string, value: object): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  } catch (error) {
    throw new ConfigurationError(
      `Could not save ${path.basename(filePath)}.`,
      ERROR_CODES.CONFIG_SAVE_FAILED,
      error
    );
  }
}
