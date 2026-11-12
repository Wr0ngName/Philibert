/**
 * Tools turned off everywhere: `deniedMcpServers` in Claude Code's user
 * settings, the one switch it has that applies in every project. Its schema
 * says of it: "deniedMcpServers still merges from all sources, so users can
 * deny servers for themselves".
 *
 * Measured on CLI 2.1.280, a server on the list is gone from what a session
 * reports (not listed as off: not listed at all), for sessions started after
 * the change — a running one keeps what it started with. It applies to
 * Claude Code in a terminal too, which calls it blocked by policy.
 *
 * An entry names a server (`{ serverName }`), or matches it by command or by
 * URL. Only the first kind is written here, and only for the name switched;
 * the others, the user's or an administrator's, are left as they are.
 */

import logger from '../../utils/logger';

import { changeUserSettings, readJsonObject, userSettingsFile } from './claude-files';
import { cliConfigDir } from './cliCredentials';

const KEY = 'deniedMcpServers';

/** An entry that names a server, and only that. */
function namesServer(entry: unknown): entry is { serverName: string } {
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    && typeof (entry as { serverName?: unknown }).serverName === 'string';
}

/**
 * The names of the servers turned off everywhere.
 *
 * @throws when the settings file is there but cannot be read as a JSON object.
 */
export async function readGloballyOff(configDir: string = cliConfigDir()): Promise<Set<string>> {
  const settings = await readJsonObject(userSettingsFile(configDir));
  const list = settings?.[KEY];
  if (!Array.isArray(list)) return new Set();
  return new Set(list.filter(namesServer).map((entry) => entry.serverName));
}

/**
 * Turn a server off everywhere, or back on — which removes the entries
 * naming it, and nothing else.
 *
 * @throws when the settings file is there but is not a JSON object: it is not written over.
 */
export async function setGloballyOff(name: string, off: boolean, configDir: string = cliConfigDir()): Promise<void> {
  await changeUserSettings((settings) => {
    const current = Array.isArray(settings[KEY]) ? (settings[KEY] as unknown[]) : [];
    const others = current.filter((entry) => !(namesServer(entry) && entry.serverName === name));
    const next = off ? [...others, { serverName: name }] : others;
    if (next.length > 0) settings[KEY] = next;
    else delete settings[KEY];
  }, configDir);
  logger.info(off ? 'Tool turned off everywhere' : 'Tool no longer turned off everywhere', {
    name,
    file: userSettingsFile(configDir),
  });
}
