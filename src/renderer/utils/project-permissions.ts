/**
 * How a saved project permission reads, wherever it is listed: the session
 * permissions dropdown, and Settings → Project.
 */

import type { ProjectPermissionEntry } from '@shared/types';

/** Main line for a project entry: the tool, or "Directory". */
export function projectEntryTitle(entry: ProjectPermissionEntry): string {
  return entry.kind === 'directory' ? 'Directory' : entry.toolName ?? entry.value;
}

/** Second line for a project entry: what the rule or directory covers. */
export function projectEntryDetail(entry: ProjectPermissionEntry): string {
  if (entry.kind === 'directory') return entry.value;
  return entry.ruleContent ?? 'Any use of this tool';
}

/** Which file it is kept in: the local one can be revoked, the shared one is read-only. */
export function projectEntrySourceLabel(entry: ProjectPermissionEntry): string {
  return entry.source === 'local'
    ? '.claude/settings.local.json'
    : '.claude/settings.json (shared, read-only)';
}
