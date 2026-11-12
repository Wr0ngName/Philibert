/**
 * Claude Code's own files that the app reads, or writes a key of:
 *
 *   <config>/settings.json   its user settings (cleanupPeriodDays,
 *                            deniedMcpServers, …)
 *   the global config file   its state: user-wide MCP servers, and per
 *                            project, among other things, the MCP servers
 *                            turned off there
 *
 * Both are Claude Code's, and shared with Claude Code run in a terminal: a
 * write changes only its own key and keeps everything else as it is, and a
 * file that cannot be read as a JSON object is never written over.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { replaceFile } from '../../utils/durable-file';

import { cliConfigDir } from './cliCredentials';

/** Claude Code's user settings file. */
export function userSettingsFile(configDir: string = cliConfigDir()): string {
  return path.join(configDir, 'settings.json');
}

/**
 * Claude Code's global config file, found as Claude Code finds it — measured
 * on CLI 2.1.280 with `claude mcp add-json --scope user`, which writes it:
 *
 *   $CLAUDE_CONFIG_DIR set     $CLAUDE_CONFIG_DIR/.claude.json
 *   ~/.claude/.config.json     that file, left from older versions
 *   otherwise                  ~/.claude.json — beside ~/.claude, not in it
 */
export function globalConfigFile(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  if (env.CLAUDE_CONFIG_DIR) return path.join(env.CLAUDE_CONFIG_DIR, '.claude.json');
  const legacy = path.join(home, '.claude', '.config.json');
  if (fs.existsSync(legacy)) return legacy;
  return path.join(home, '.claude.json');
}

/**
 * A JSON object file as an object; null when there is none.
 *
 * @throws when it is there but is not a JSON object.
 */
export async function readJsonObject(file: string): Promise<Record<string, unknown> | null> {
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

/**
 * Change Claude Code's user settings, keeping every key `change` leaves.
 *
 * @throws when the file is there but is not a JSON object: it is not written over.
 */
export async function changeUserSettings(
  change: (settings: Record<string, unknown>) => void,
  configDir: string = cliConfigDir(),
): Promise<void> {
  const file = userSettingsFile(configDir);
  const settings = (await readJsonObject(file)) ?? {};
  change(settings);
  await fs.promises.mkdir(configDir, { recursive: true });
  await replaceFile(file, `${JSON.stringify(settings, null, 2)}\n`);
}
