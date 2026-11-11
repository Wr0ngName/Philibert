/**
 * How long Claude Code keeps session transcripts: `cleanupPeriodDays` in its
 * user settings (`<config>/settings.json`). Claude Code deletes the
 * transcripts older than that, and a discussion whose transcript is gone has
 * nothing left to continue (Conversation.sessionGone) — so the archive
 * setting is only useful below it, and the settings let the user set both.
 *
 * The file is Claude Code's, and shared with Claude Code run in a terminal:
 * only this one key is written, everything else in it is kept as it is, and
 * a file that cannot be read as JSON is never written over.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CLAUDE_DEFAULT_SESSION_RETENTION_DAYS, type SessionRetention } from '../../../shared/types';
import { replaceFile } from '../../utils/durable-file';
import logger from '../../utils/logger';

import { cliConfigDir } from './cliCredentials';

const KEY = 'cleanupPeriodDays';

function settingsFile(configDir: string): string {
  return path.join(configDir, 'settings.json');
}

/** The settings file as an object; null when there is none, throws when it is not a JSON object. */
async function readSettings(file: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await fs.promises.readFile(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} does not hold a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function isRetentionDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** How long Claude Code keeps sessions, as its user settings say. */
export async function readSessionRetention(configDir: string = cliConfigDir()): Promise<SessionRetention> {
  const file = settingsFile(configDir);
  let settings: Record<string, unknown> | null;
  try {
    settings = await readSettings(file);
  } catch (error) {
    logger.warn("Claude Code's settings could not be read", { file, error });
    return { status: 'unreadable' };
  }
  const value = settings?.[KEY];
  if (value === undefined) return { status: 'default', days: CLAUDE_DEFAULT_SESSION_RETENTION_DAYS };
  if (!isRetentionDays(value)) {
    logger.warn(`Claude Code's ${KEY} is not a whole number of days`, { file, value });
    return { status: 'unreadable' };
  }
  return { status: 'set', days: value };
}

/**
 * Set how long Claude Code keeps sessions, leaving the rest of its user
 * settings as they are.
 *
 * @throws when `days` is not a whole number of at least 1, or the settings
 *   file is there but is not a JSON object — it is not written over.
 */
export async function writeSessionRetention(days: number, configDir: string = cliConfigDir()): Promise<SessionRetention> {
  if (!isRetentionDays(days)) throw new Error(`${KEY} must be a whole number of days, at least 1: ${days}`);
  const file = settingsFile(configDir);
  const settings = (await readSettings(file)) ?? {};
  settings[KEY] = days;
  await fs.promises.mkdir(configDir, { recursive: true });
  await replaceFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  logger.info(`Set Claude Code's ${KEY}`, { file, days });
  return { status: 'set', days };
}
