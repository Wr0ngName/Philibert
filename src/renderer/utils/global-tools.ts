/**
 * The tools every project has — claude.ai connectors and user-wide servers —
 * as the two settings pages list them.
 *
 * What a Claude Code session reports leaves out a tool turned off
 * everywhere: it is not listed at all (measured on CLI 2.1.280). So the
 * lists are made from what is reported plus the names turned off everywhere,
 * which is how such a tool is still shown — and can be turned back on.
 */

import { CLAUDE_AI_CONNECTOR_PREFIX } from '@shared/types';
import type { GlobalTools, GlobalToolStatus, ProjectTools } from '@shared/types';

/** Whether a name is a claude.ai connector's: Claude Code names them `claude.ai <name>`. */
export function isConnectorName(name: string): boolean {
  return name.startsWith(CLAUDE_AI_CONNECTOR_PREFIX);
}

/** "claude.ai Gmail" reads as "Gmail" under a claude.ai heading. */
export function displayName(name: string): string {
  return isConnectorName(name) ? name.slice(CLAUDE_AI_CONNECTOR_PREFIX.length) : name;
}

const byDisplayName = (a: { name: string }, b: { name: string }) =>
  displayName(a.name).localeCompare(displayName(b.name));

/** A connector on the global page. */
export interface ConnectorRow {
  name: string;
  /** As reported; null when it is not, being off everywhere. */
  status: GlobalToolStatus | null;
  offEverywhere: boolean;
}

/** The connectors: those reported, and those off everywhere, which are not. */
export function connectorRows(tools: GlobalTools): ConnectorRow[] {
  const off = new Set(tools.offEverywhere);
  const reported = (tools.statuses ?? []).filter((tool) => tool.kind === 'connector');
  const rows: ConnectorRow[] = reported.map((status) => ({ name: status.name, status, offEverywhere: off.has(status.name) }));
  for (const name of tools.offEverywhere) {
    if (isConnectorName(name) && !rows.some((row) => row.name === name)) {
      rows.push({ name, status: null, offEverywhere: true });
    }
  }
  return rows.sort(byDisplayName);
}

/**
 * Names off everywhere that are neither a connector nor a user-wide server:
 * a project's own server, say, or one turned off by hand in Claude Code's
 * settings. Listed so they can be turned back on.
 */
export function otherOffEverywhere(tools: GlobalTools): string[] {
  const userServers = new Set(tools.userServers.map((server) => server.name));
  return tools.offEverywhere
    .filter((name) => !isConnectorName(name) && !userServers.has(name))
    .sort((a, b) => a.localeCompare(b));
}

/** How a tool every project has stands in one project. */
export type ProjectToolState =
  /** Off in every project: wins over the project, which cannot turn it on. */
  | 'off-everywhere'
  /** On in every project, turned off in this one. */
  | 'off-here'
  | 'on';

/** A tool every project has, on the project page. */
export interface ProjectToolRow {
  name: string;
  kind: GlobalToolStatus['kind'];
  state: ProjectToolState;
  /** As the project's session reports it; null when it is not: off everywhere, or no session. */
  status: GlobalToolStatus | null;
}

/** The connectors and user-wide servers, each as the project has it. */
export function projectToolRows(tools: ProjectTools): ProjectToolRow[] {
  const off = new Set(tools.offEverywhere);
  const reported = new Map((tools.statuses ?? []).map((status) => [status.name, status]));
  const names = new Set<string>([
    ...reported.keys(),
    ...tools.userServers,
    ...tools.offEverywhere.filter(isConnectorName),
  ]);
  return [...names].map((name): ProjectToolRow => {
    const status = reported.get(name) ?? null;
    const kind = status?.kind ?? (isConnectorName(name) ? 'connector' : 'user');
    const state: ProjectToolState = off.has(name) ? 'off-everywhere' : status?.status === 'disabled' ? 'off-here' : 'on';
    return { name, kind, state, status };
  }).sort(byDisplayName);
}

/** What the project page says of a tool's state. */
export const PROJECT_TOOL_STATE_LABEL: Record<ProjectToolState, string> = {
  'off-everywhere': 'Off in global settings',
  'off-here': 'On globally · off in this project',
  on: 'On',
};
