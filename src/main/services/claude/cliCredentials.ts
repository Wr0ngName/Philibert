/**
 * The CLI's own login files in Philibert's config directory
 * (CLAUDE_CONFIG_DIR = <userData>/claude-config).
 *
 * `claude auth login` writes two files there: `.credentials.json` — an access
 * token, the refresh token, their expiry — and `oauthAccount` in
 * `.claude.json`, which is where the CLI reads the account's email,
 * organization and plan from. The CLI refreshes the access token by itself
 * and writes the new one back to `.credentials.json`.
 *
 * So once written, that file is the truth, and Philibert's encrypted copy
 * follows it rather than the other way round. Session start used to write the
 * copy saved at login over the file every time, which put back the token the
 * CLI had just replaced; the next request then failed with a 401 and the 401
 * handler logged the user out.
 */

import * as fs from 'fs';
import * as path from 'path';

import { getClaudeConfigDir } from '../../utils/resourcePaths';

const CREDENTIALS_FILE = '.credentials.json';
const GLOBAL_CONFIG_FILE = '.claude.json';

export function credentialsFilePath(configDir: string = getClaudeConfigDir()): string {
  return path.join(configDir, CREDENTIALS_FILE);
}

/**
 * The credentials file's content when it holds a login, or null.
 *
 * A login is an object with `claudeAiOauth.accessToken`, as `auth login`
 * writes it. Anything else — missing, half-written, not JSON — is no login.
 */
export function readCliCredentials(configDir: string = getClaudeConfigDir()): string | null {
  try {
    const raw = fs.readFileSync(credentialsFilePath(configDir), 'utf8');
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } };
    return typeof parsed?.claudeAiOauth?.accessToken === 'string' ? raw : null;
  } catch {
    return null;
  }
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

/** Write the credentials file, readable by this user only, as the CLI does. */
export function writeCliCredentials(credentialsJson: string, configDir: string = getClaudeConfigDir()): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(credentialsFilePath(configDir), credentialsJson, { encoding: 'utf8', mode: 0o600 });
}

/** Remove the credentials file, for a logout. */
export function removeCliCredentials(configDir: string = getClaudeConfigDir()): void {
  fs.rmSync(credentialsFilePath(configDir), { force: true });
}

/** The `oauthAccount` record of a config directory, as JSON, or null. */
export function readOAuthAccount(configDir: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, GLOBAL_CONFIG_FILE), 'utf8')) as { oauthAccount?: unknown };
    return parsed?.oauthAccount && typeof parsed.oauthAccount === 'object' ? JSON.stringify(parsed.oauthAccount) : null;
  } catch {
    return null;
  }
}

/**
 * Put a login's `oauthAccount` into the config directory's `.claude.json`,
 * keeping everything else the CLI keeps there (project history, settings it
 * has learned). Replacing the file would lose that; leaving it out leaves the
 * CLI with credentials but no idea whose they are.
 */
export function mergeOAuthAccount(accountJson: string, configDir: string = getClaudeConfigDir()): void {
  const file = path.join(configDir, GLOBAL_CONFIG_FILE);
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
  } catch {
    // No file yet, or not one the CLI would read either: start it.
  }
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...current, oauthAccount: JSON.parse(accountJson) }, null, 2), { encoding: 'utf8', mode: 0o600 });
}
