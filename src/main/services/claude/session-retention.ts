/**
 * How long Claude Code keeps session transcripts: `cleanupPeriodDays` in its
 * user settings (`<config>/settings.json`). Claude Code deletes the
 * transcripts older than that, and a discussion whose transcript is gone has
 * nothing left to continue (Conversation.sessionGone) — so the archive
 * setting is only useful below it, and the settings let the user set both.
 *
 * The file is Claude Code's, and shared with Claude Code run in a terminal
 * (see claude-files): only this one key is written.
 */

import { CLAUDE_DEFAULT_SESSION_RETENTION_DAYS, type SessionRetention } from '../../../shared/types';
import logger from '../../utils/logger';

import { changeUserSettings, readJsonObject, userSettingsFile } from './claude-files';
import { cliConfigDir } from './cliCredentials';

const KEY = 'cleanupPeriodDays';

function isRetentionDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** How long Claude Code keeps sessions, as its user settings say. */
export async function readSessionRetention(configDir: string = cliConfigDir()): Promise<SessionRetention> {
  const file = userSettingsFile(configDir);
  let settings: Record<string, unknown> | null;
  try {
    settings = await readJsonObject(file);
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
  await changeUserSettings((settings) => {
    settings[KEY] = days;
  }, configDir);
  logger.info(`Set Claude Code's ${KEY}`, { file: userSettingsFile(configDir), days });
  return { status: 'set', days };
}
