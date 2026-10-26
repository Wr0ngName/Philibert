/**
 * The Claude CLI's own login, which Philibert shares.
 *
 * `claude auth login` keeps its login in the CLI's config directory — the
 * credentials (access token, refresh token) in `.credentials.json`, the
 * account in the global config — and refreshes the token there by itself.
 * Philibert runs the CLI with its normal config directory, so a login made in
 * Philibert is the terminal's login too, and the other way round.
 *
 * It used to give the CLI a directory of its own (CLAUDE_CONFIG_DIR =
 * <userData>/claude-config). That moved far more than the login: the CLI
 * keeps its sessions, settings.json, CLAUDE.md, agents, skills, plugins and
 * MCP servers in the same directory, so every older discussion failed to
 * resume and none of the user's own configuration applied.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import logger from '../../utils/logger';
import type ConfigService from '../ConfigService';

const CREDENTIALS_FILE = '.credentials.json';

/**
 * The CLI's config directory: `$CLAUDE_CONFIG_DIR` when the user set one,
 * `~/.claude` otherwise — the CLI's own rule.
 */
export function cliConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function credentialsFilePath(configDir: string = cliConfigDir()): string {
  return path.join(configDir, CREDENTIALS_FILE);
}

/**
 * The credentials file's content when it holds a login, or null.
 *
 * A login is an object with `claudeAiOauth.accessToken`, as `auth login`
 * writes it. Anything else — missing, half-written, not JSON — is no login.
 */
export function readCliCredentials(configDir: string = cliConfigDir()): string | null {
  try {
    const raw = fs.readFileSync(credentialsFilePath(configDir), 'utf8');
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } };
    return typeof parsed?.claudeAiOauth?.accessToken === 'string' ? raw : null;
  } catch {
    return null;
  }
}

/** Whether the CLI has a login. */
export function hasCliLogin(configDir: string = cliConfigDir()): boolean {
  return readCliCredentials(configDir) !== null;
}

/** The access token in a credentials file's content. */
export function accessTokenOf(credentialsJson: string): string | null {
  try {
    const token = (JSON.parse(credentialsJson) as { claudeAiOauth?: { accessToken?: unknown } })?.claudeAiOauth?.accessToken;
    return typeof token === 'string' ? token : null;
  } catch {
    return null;
  }
}

/**
 * Log Philibert out of a CLI login the CLI no longer has — logged out in a
 * terminal (`claude auth logout`), or never there. Philibert would otherwise
 * go on looking logged in, and every request would fail. Returns whether it
 * did, so the caller can tell the window.
 */
export async function dropVanishedCliLogin(configService: ConfigService): Promise<boolean> {
  if (!(await configService.usesCliLogin()) || hasCliLogin()) return false;
  logger.info('The Claude CLI login is gone; logging Philibert out of it');
  await configService.setConfig({ oauthToken: '', authMethod: 'none' });
  await configService.setUsesCliLogin(false);
  return true;
}

/**
 * On start: undo what 0.25.0-rc.1 and rc.2 did, for an install that ran them.
 * The sessions and login in their separate directory are migrated (below),
 * the encrypted copy of the credentials they kept is dropped, and if that
 * install was logged in, its login becomes the CLI's own — so Philibert is
 * logged in when the CLI is, and asks for a login when it is not. Then, for
 * every install, a CLI login the CLI no longer has is dropped.
 */
export async function migrateFromSeparateCliLogin(configService: ConfigService, separateDir: string): Promise<void> {
  try {
    const hadStoredCopy = await configService.forgetStoredCliCredentials();
    const { hadLogin } = migrateSeparateConfigDir(separateDir);
    if (hadStoredCopy || hadLogin) await configService.setUsesCliLogin(true);
    // Before the window reads the login: if the CLI has none, ask for one.
    await dropVanishedCliLogin(configService);
  } catch (error) {
    logger.error('Could not migrate from the separate CLI directory', { error });
  }
}

/**
 * Bring back what 0.25.0-rc.1 and rc.2 put in Philibert's own CLI directory
 * (<userData>/claude-config), now that the CLI runs with its normal one.
 *
 * - Sessions: each discussion started on those builds has its session there.
 *   They are moved into the CLI's `projects`, under the same project folder,
 *   so those discussions resume too. A session already present is left.
 * - The login: removed. It was a separate login, and the CLI no longer
 *   reads it; Philibert asks for a login again unless the CLI already has one.
 *
 * Returns whether that directory held a login, so the caller can drop the
 * login Philibert recorded for it. Idempotent: once moved, there is nothing
 * left to move.
 */
export function migrateSeparateConfigDir(separateDir: string, configDir: string = cliConfigDir()): { hadLogin: boolean; movedSessions: number } {
  const hadLogin = readCliCredentials(separateDir) !== null;
  let movedSessions = 0;

  const fromProjects = path.join(separateDir, 'projects');
  let projects: fs.Dirent[] = [];
  try {
    projects = fs.readdirSync(fromProjects, { withFileTypes: true });
  } catch {
    // Nothing was ever run there.
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const from = path.join(fromProjects, project.name);
    const to = path.join(configDir, 'projects', project.name);
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      const target = path.join(to, entry);
      if (fs.existsSync(target)) continue;
      try {
        fs.renameSync(path.join(from, entry), target);
        if (entry.endsWith('.jsonl')) movedSessions += 1;
      } catch (error) {
        logger.warn('Could not move a session out of the separate CLI directory', { entry, error });
      }
    }
  }

  if (hadLogin) fs.rmSync(credentialsFilePath(separateDir), { force: true });
  if (hadLogin || movedSessions > 0) {
    logger.info('Migrated the separate CLI directory', { hadLogin, movedSessions });
  }
  return { hadLogin, movedSessions };
}
