/**
 * Slash command resolution and GUI dispositions.
 *
 * ── Where the command list comes from ──
 * The SDK's `supportedCommands()` is the only source. It returns Claude Code's
 * own commands as well as whatever the project, plugins and MCP servers define,
 * each row carrying `aliases` and a `builtin` marker. Philibert does not keep a
 * list of its own: a hand-maintained table goes stale the moment the CLI gains
 * a command (that is how `/rewind` came to be missing), and nothing here can
 * know about a project's custom commands anyway.
 *
 * ── What this module decides ──
 * Only how a resolved command should be *handled*, which is a property of this
 * GUI and not of the CLI. Three things can be true of a command:
 *
 *   - The CLI handles it perfectly well through a normal prompt turn. This is
 *     the DEFAULT and needs no entry below: a command we have never heard of
 *     passes straight through, so the app keeps working as the CLI grows.
 *   - It needs a terminal UI the CLI draws itself (an interactive picker, a
 *     wizard), which cannot render in a chat window. Then the GUI either does
 *     the same job its own way, or points at the surface that does.
 *   - It genuinely does not apply to a GUI at all.
 *
 * Everything in GUI_DISPOSITIONS is one of the last two. Nothing is listed
 * merely to describe it — descriptions come from the SDK rows.
 */

import type { SlashCommandInfo } from './types';

/** A command the GUI implements itself, rendering the answer into the chat. */
export type GuiCommandAction =
  | 'help'
  | 'clear'
  | 'usage'
  | 'context'
  | 'status'
  | 'doctor'
  | 'bug'
  | 'memory'
  | 'model'
  | 'rewind';

/** A GUI surface a command can hand the user to. */
export type CommandNavigationTarget = 'settings' | 'settings-auth' | 'settings-mcp' | 'about';

/**
 * How a resolved command should be handled.
 *
 * `sdk` is the default for anything not named in GUI_DISPOSITIONS, so the set
 * of commands the app supports grows with the CLI rather than with this file.
 */
export type CommandDisposition =
  | { kind: 'sdk' }
  | { kind: 'gui'; action: GuiCommandAction }
  | { kind: 'navigate'; target: CommandNavigationTarget; message: string }
  | { kind: 'unavailable'; message: string };

/**
 * Commands this GUI handles instead of passing to the CLI.
 *
 * Keyed by the command's own `name` as the SDK reports it, never by an alias:
 * aliases are resolved first (`/cost` resolves to `usage`, so `/cost` is
 * handled by the `usage` entry and needs no entry of its own).
 */
export const GUI_DISPOSITIONS: Readonly<Record<string, CommandDisposition>> = {
  // Commands the GUI answers itself, from data it already holds.
  help: { kind: 'gui', action: 'help' },
  clear: { kind: 'gui', action: 'clear' },
  usage: { kind: 'gui', action: 'usage' },
  context: { kind: 'gui', action: 'context' },
  status: { kind: 'gui', action: 'status' },
  doctor: { kind: 'gui', action: 'doctor' },
  bug: { kind: 'gui', action: 'bug' },
  memory: { kind: 'gui', action: 'memory' },
  model: { kind: 'gui', action: 'model' },

  // The CLI draws an interactive checkpoint picker for this one; the GUI shows
  // the same choice as a dialog and calls Query.rewindFiles / resumeSessionAt.
  rewind: { kind: 'gui', action: 'rewind' },

  // Commands whose job is done by a GUI surface. The message says what the
  // surface is called, because "open Settings" is useless if the user then has
  // to hunt for the control.
  config: {
    kind: 'navigate',
    target: 'settings',
    message: 'Opening **Settings**, where everything the CLI\'s `/config` covers lives.',
  },
  permissions: {
    kind: 'navigate',
    target: 'settings',
    message:
      'Opening **Settings**. Tool permissions are requested as tools are first used, ' +
      'and the ones this session has already granted are listed in the shield menu ' +
      'beside the model selector, where they can be revoked.',
  },
  'allowed-tools': {
    kind: 'navigate',
    target: 'settings',
    message:
      'Opening **Settings**. Tool permissions are requested as tools are first used, ' +
      'and the ones this session has already granted are listed in the shield menu ' +
      'beside the model selector, where they can be revoked.',
  },
  login: {
    kind: 'navigate',
    target: 'settings-auth',
    message: 'Opening **Settings → Authentication**, where you can switch account or re-authenticate.',
  },
  logout: {
    kind: 'navigate',
    target: 'settings-auth',
    message: 'Opening **Settings → Authentication**. Use **Logout** there to sign out.',
  },
  mcp: {
    kind: 'navigate',
    target: 'settings-mcp',
    // Deliberately does not mention `claude mcp add`: its default and `user`
    // scopes write to $CLAUDE_CONFIG_DIR/.claude.json, and Philibert points
    // that variable at its own config directory, so a server added that way
    // from a terminal is invisible here. See docs/mcp-servers.md.
    message:
      'Opening **Settings → Tool Servers**. Philibert writes both files Claude Code needs — ' +
      '`.mcp.json` and the matching approval in `.claude/settings.local.json` — so a server ' +
      'added there is ready to use. Changes apply to **new conversations**; this one keeps the ' +
      'servers it started with.',
  },

  // Commands that do not apply to a GUI. Each says what it would have done and
  // what to do instead, rather than only that it is unavailable.
  vim: {
    kind: 'unavailable',
    message:
      'Vim keybindings apply to the CLI\'s own terminal editor. The prompt box here is a ' +
      'standard text field, with your platform\'s editing shortcuts and right-click menu.',
  },
  'terminal-setup': {
    kind: 'unavailable',
    message:
      'This installs Shift+Enter keybindings into iTerm2 or the VS Code terminal, which only ' +
      'affects the CLI. In Philibert, Shift+Enter already inserts a newline and Enter sends.',
  },
  'install-github-app': {
    kind: 'unavailable',
    message:
      'Installing the GitHub app runs an interactive browser and repository flow that Philibert ' +
      'does not host. Run `claude /install-github-app` in a terminal; once installed it applies ' +
      'to this project too, since it is configured in the repository rather than in the client.',
  },
  agents: {
    kind: 'unavailable',
    message:
      'The CLI\'s `/agents` is an interactive editor, which Philibert has no screen for yet. ' +
      'Subagents are plain Markdown files with YAML frontmatter — `.claude/agents/<name>.md` in ' +
      'the project, or `~/.claude/agents/<name>.md` for your own — and any you add are picked ' +
      'up by **new conversations**.',
  },
};

/** A slash command input split into its name and the rest of the line. */
export interface ParsedSlashInput {
  /** Command name as typed, without the leading slash, lowercased. */
  name: string;
  /** Everything after the command name, trimmed. Empty when no arguments. */
  args: string;
}

/**
 * Split a raw prompt into a command name and its arguments.
 *
 * Returns null when the text is not a command, which includes the bare "/" a
 * user has just typed and a path like "/usr/bin" pasted as a prompt — a name
 * is required, and a name cannot contain a slash.
 */
export function parseSlashInput(raw: string): ParsedSlashInput | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) return null;

  const withoutSlash = trimmed.slice(1);
  // The name must be followed by whitespace or nothing at all. Allowing
  // anything else would read "/usr/bin/env python" as the command "usr" with
  // "/bin/env python" as its arguments, and send that instead of the prompt
  // the user pasted.
  const match = /^([^\s/]+)(?:\s+([\s\S]*))?$/.exec(withoutSlash);
  if (!match) return null;

  return { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

/**
 * Find the command a typed name resolves to.
 *
 * Follows the SDK's own rule for `builtin`, quoted from the SlashCommand type:
 * "Rows can share a name: when a marked row carries it, /name runs that one,
 * and an unmarked row is the one /name runs only when no marked row shares its
 * name. The marker describes the row's name, not its aliases: a typed alias
 * runs a command that has it as its name, when one exists, whatever this
 * marker says."
 *
 * So: an exact name match always beats an alias match, and among rows sharing a
 * name the builtin one wins.
 */
export function findCommand(
  commands: readonly SlashCommandInfo[],
  typedName: string,
): SlashCommandInfo | undefined {
  const needle = typedName.toLowerCase();

  const byName = commands.filter((cmd) => cmd.name.toLowerCase() === needle);
  if (byName.length > 0) {
    return byName.find((cmd) => cmd.builtin) ?? byName[0];
  }

  return commands.find((cmd) => cmd.aliases?.some((alias) => alias.toLowerCase() === needle));
}

/**
 * How a command should be handled. Anything not named in GUI_DISPOSITIONS goes
 * to the CLI, so an unknown command is passed through rather than rejected.
 */
export function dispositionFor(command: SlashCommandInfo): CommandDisposition {
  return GUI_DISPOSITIONS[command.name.toLowerCase()] ?? { kind: 'sdk' };
}

/**
 * Shortest query that also searches descriptions.
 *
 * Descriptions are prose, so one or two letters match nearly all of them —
 * "co" appears in "commands", "conversation" and "compact" alike, which turns
 * a narrowing keystroke into a wall of results. Names and aliases are matched
 * at any length; descriptions only once the query is specific enough to mean
 * something.
 */
const MIN_DESCRIPTION_QUERY_LENGTH = 3;

/** A command plus how it matched, for ordering the autocomplete. */
interface RankedCommand {
  command: SlashCommandInfo;
  rank: number;
  /** The alias that matched, when the match was not on the name. */
  matchedAlias?: string;
}

/**
 * Rank commands for the autocomplete.
 *
 * Ordering, best first:
 *   0. the name starts with the query
 *   1. an alias starts with the query
 *   2. the name contains the query
 *   3. an alias contains the query
 *   4. the description contains the query, from three characters up
 *
 * Within a rank, Claude Code's own commands come before project and plugin
 * ones, then alphabetically — so `/re` offers `/rewind` before a project
 * command called `/rebase-helper`, and the order never shifts about between
 * keystrokes. Matching the description is what makes the list searchable by
 * what a command does when its name is not obvious ("undo" finds `/rewind`
 * when the description mentions it).
 */
export function rankCommandMatches(
  commands: readonly SlashCommandInfo[],
  query: string,
): SlashCommandInfo[] {
  const needle = query.trim().toLowerCase();

  const ordered = [...commands].sort((a, b) => {
    if (!!a.builtin !== !!b.builtin) return a.builtin ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  if (!needle) return ordered;

  const ranked: RankedCommand[] = [];

  for (const command of ordered) {
    const name = command.name.toLowerCase();
    const aliases = (command.aliases ?? []).map((alias) => alias.toLowerCase());

    if (name.startsWith(needle)) {
      ranked.push({ command, rank: 0 });
      continue;
    }

    const aliasPrefix = aliases.find((alias) => alias.startsWith(needle));
    if (aliasPrefix) {
      ranked.push({ command, rank: 1, matchedAlias: aliasPrefix });
      continue;
    }

    if (name.includes(needle)) {
      ranked.push({ command, rank: 2 });
      continue;
    }

    const aliasInfix = aliases.find((alias) => alias.includes(needle));
    if (aliasInfix) {
      ranked.push({ command, rank: 3, matchedAlias: aliasInfix });
      continue;
    }

    if (
      needle.length >= MIN_DESCRIPTION_QUERY_LENGTH &&
      command.description?.toLowerCase().includes(needle)
    ) {
      ranked.push({ command, rank: 4 });
    }
  }

  // Stable sort on rank alone: `ordered` already fixed the tie-break, and
  // Array.prototype.sort is required to be stable.
  ranked.sort((a, b) => a.rank - b.rank);

  return ranked.map((entry) => entry.command);
}
