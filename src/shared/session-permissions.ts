/**
 * Session permissions: what "allow for this session" grants, as the main
 * process hands it to the CLI and the discussion saves it.
 *
 * The CLI is what matches a rule against a tool call: Philibert keeps the
 * session's grants (SessionPermissionCache) and gives them to the CLI as allow
 * rules in its flag-settings layer, written in the CLI's own rule syntax.
 */

import type { SessionPermissionEntry } from './types';

/** The tools whose input is a command line, which the CLI writes rules for one command at a time. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);

/**
 * A rule as the CLI writes it in a settings file: the tool alone, or
 * `Tool(content)` with `\`, `(` and `)` in the content escaped with a
 * backslash. The CLI 2.1.280 bundle serialises rules this way (`Yn` / `a`)
 * and parses them back by unescaping the same three characters (`Jn` /
 * `Akr`), so a command with parentheses round-trips: measured with
 * `Bash(touch "\(x\) y, z")` allowing `touch "(x) y, z"` without an ask.
 */
export function cliRuleString(toolName: string, ruleContent?: string): string {
  if (!ruleContent) return toolName;
  const escaped = ruleContent.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  return `${toolName}(${escaped})`;
}

/**
 * An entry as a saved discussion holds it, in today's shape.
 *
 * Discussions saved before entries had a `kind` wrote every grant as a tool
 * name: `mode:<mode>` for a permission mode, `*` for bypassPermissions,
 * `dir:<path>` for a directory, and the tool's name for a rule. Those are
 * read into the matching kind. Anything that is not an entry at all — no id,
 * no name — is dropped, so a damaged save cannot grant something by accident.
 */
export function normalizeSessionEntry(raw: unknown): SessionPermissionEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== 'string' || e.id.length === 0) return null;
  const base = {
    id: e.id,
    description: typeof e.description === 'string' ? e.description : '',
    grantedAt: typeof e.grantedAt === 'number' ? e.grantedAt : 0,
  };

  if (e.kind === 'mode') {
    return typeof e.mode === 'string' && e.mode ? { ...base, kind: 'mode', mode: e.mode } : null;
  }
  if (e.kind === 'directory') {
    return typeof e.directory === 'string' && e.directory ? { ...base, kind: 'directory', directory: e.directory } : null;
  }
  if (e.kind !== undefined && e.kind !== 'rule') return null;

  if (typeof e.toolName !== 'string' || e.toolName.length === 0) return null;
  if (e.kind === undefined) {
    if (e.toolName === '*') return { ...base, kind: 'mode', mode: 'bypassPermissions' };
    if (e.toolName.startsWith('mode:')) {
      const mode = e.toolName.slice('mode:'.length);
      return mode ? { ...base, kind: 'mode', mode } : null;
    }
    if (e.toolName.startsWith('dir:')) {
      const directory = e.toolName.slice('dir:'.length);
      return directory ? { ...base, kind: 'directory', directory } : null;
    }
  }
  return {
    ...base,
    kind: 'rule',
    toolName: e.toolName,
    ...(typeof e.ruleContent === 'string' && e.ruleContent ? { ruleContent: e.ruleContent } : {}),
    ...(e.sandboxed === true ? { sandboxed: true } : {}),
  };
}

/** Every entry of a saved list that is one, in today's shape. */
export function normalizeSessionEntries(raw: unknown): SessionPermissionEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeSessionEntry).filter((e): e is SessionPermissionEntry => e !== null);
}

/**
 * Whether a rule is in force for a session that runs sandboxed or not: a
 * shell rule granted inside the sandbox allows nothing outside it.
 */
export function ruleInForce(entry: SessionPermissionEntry, sandboxed: boolean): boolean {
  return entry.kind === 'rule' && (!entry.sandboxed || sandboxed);
}

/** What the permissions list names an entry by. */
export function sessionEntryTitle(entry: SessionPermissionEntry): string {
  switch (entry.kind) {
    case 'rule':
      return entry.ruleContent ? `${entry.toolName} (${entry.ruleContent})` : entry.toolName;
    case 'mode':
      return `Mode: ${entry.mode}`;
    case 'directory':
      return `Directory: ${entry.directory}`;
  }
}
