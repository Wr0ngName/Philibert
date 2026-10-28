/**
 * Which of the user's git credential helpers will keep a login for a host —
 * what the sign-in dialog tells the user before they type one in.
 *
 * Read from git's configuration, the way git builds its list:
 *  - `credential.helper` values, in order, across system, global and local
 *    config, where an empty value clears the ones before it;
 *  - `credential.<url>.helper` values whose URL is for that host.
 *
 * Philibert's own helper is not among them: it is added to the push or pull
 * command itself, never written to a config file, and keeps nothing.
 */

/** A configured value: the scope (empty for plain `credential.helper`) and the helper. */
export interface ConfiguredHelper {
  /** The `<url>` of `credential.<url>.helper`, or '' for `credential.helper`. */
  scope: string;
  value: string;
}

/** Whether a `credential.<url>` scope applies to this host. */
function scopeMatches(scope: string, host: string): boolean {
  try {
    return new URL(scope.includes('://') ? scope : `https://${scope}`).host === host;
  } catch {
    return false;
  }
}

/** The helpers git will use for a host, in config order. */
export function effectiveHelpers(configured: ConfiguredHelper[], host: string): string[] {
  let helpers: string[] = [];
  for (const { scope, value } of configured) {
    if (scope && !scopeMatches(scope, host)) continue;
    if (value === '') helpers = [];
    else helpers.push(value);
  }
  return helpers;
}

/**
 * Parse `git config --get-regexp ^credential\..*helper$` output: one
 * `<key> <value>` per line, the key being `credential.helper` or
 * `credential.<url>.helper`.
 */
export function parseHelperConfig(output: string): ConfiguredHelper[] {
  const configured: ConfiguredHelper[] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'credential.helper') {
      configured.push({ scope: '', value });
    } else if (key.startsWith('credential.') && key.endsWith('.helper')) {
      configured.push({ scope: key.slice('credential.'.length, -'.helper'.length), value });
    }
  }
  return configured;
}

/** The helpers that keep a login only for a while, in memory. */
const TEMPORARY = new Set(['cache']);

/**
 * The first word of a helper command, as the shell git runs it through
 * reads it: a path with a space is quoted (`"C:/Program Files/…"`) or has
 * the space escaped (`C:/Program\ Files/…`).
 */
function firstShellWord(command: string): string {
  let word = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '\\' && i + 1 < command.length) {
      i += 1;
      word += command[i];
    } else if (/\s/.test(c)) {
      if (word) break;
    } else {
      word += c;
    }
  }
  return word;
}

/** A helper's command name: `store` for `store --file=x`, `manager` for `/path/git-credential-manager.exe`. */
export function helperName(value: string): string {
  const command = value.startsWith('!') ? value.slice(1).trim() : value.trim();
  return firstShellWord(command)
    .split(/[\\/]/).pop()!
    .replace(/\.exe$/i, '')
    .replace(/^git-credential-/, '');
}

/** What a helper is, for the user. */
export function describeHelper(value: string): string {
  switch (helperName(value)) {
    case 'manager':
    case 'manager-core':
      return 'Git Credential Manager';
    case 'wincred':
      return 'Windows Credential Manager';
    case 'osxkeychain':
      return 'the macOS Keychain';
    case 'libsecret':
    case 'gnome-keyring':
      return 'the system keyring';
    case 'store':
      return 'git-credential-store (a plain-text file)';
    case 'cache':
      return 'git-credential-cache (in memory, for a while)';
    default:
      return helperName(value) || value;
  }
}

/** Whether the helpers will remember a login beyond a while in memory. */
export function keepsLogin(helpers: string[]): boolean {
  return helpers.some((value) => !TEMPORARY.has(helperName(value)));
}
