/**
 * Project-scoped tool permissions.
 *
 * "Allow in project" in the approval modal hands the SDK a `localSettings`
 * permission update, and the CLI persists it into the project's
 * `.claude/settings.local.json`:
 *
 *   permissions.allow                  rules, e.g. "Bash(npm test)", "Write"
 *   permissions.additionalDirectories  directories outside the working dir
 *
 * This service lists those entries — plus the ones in the shared
 * `.claude/settings.json`, which apply just the same — and removes entries
 * from the local file. The shared file is usually committed for the whole
 * team, so it is never edited from here.
 *
 * A running CLI re-reads the settings file when it changes, so a revoked rule
 * takes effect on the very next tool call without restarting the session
 * (verified against the bundled CLI).
 */

import type {
  ProjectPermissionEntry,
  ProjectPermissionSource,
} from '../../shared/types';
import { ValidationError, ERROR_CODES } from '../errors';
import logger from '../utils/logger';
import {
  getLocalSettingsPath,
  getSharedSettingsPath,
  readJsonFile,
  writeJsonFile,
} from '../utils/projectSettings';

interface RawSettings {
  permissions?: {
    allow?: unknown;
    additionalDirectories?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Settings key holding the values of each entry kind. */
const KEY_BY_KIND = {
  rule: 'allow',
  directory: 'additionalDirectories',
} as const satisfies Record<ProjectPermissionEntry['kind'], string>;

/** `Tool(specifier)` — the CLI's permission rule syntax. */
const RULE_PATTERN = /^([^(]+)\((.*)\)$/s;

export class ProjectPermissionService {
  /**
   * Every allow rule and additional directory in the project's settings files,
   * local entries first. Missing files simply contribute nothing.
   */
  list(workingDirectory: string): ProjectPermissionEntry[] {
    return [
      ...this.readEntries(getLocalSettingsPath(workingDirectory), 'local'),
      ...this.readEntries(getSharedSettingsPath(workingDirectory), 'shared'),
    ];
  }

  /**
   * Remove an entry from `.claude/settings.local.json`, leaving every other
   * key of the file as it was. Returns the updated list.
   */
  revoke(
    workingDirectory: string,
    kind: ProjectPermissionEntry['kind'],
    value: string
  ): ProjectPermissionEntry[] {
    const filePath = getLocalSettingsPath(workingDirectory);
    const settings = readJsonFile<RawSettings>(filePath);
    const key = KEY_BY_KIND[kind];
    const current = this.toStrings(settings.permissions?.[key]);

    if (!current.includes(value)) {
      throw new ValidationError(
        `"${value}" is not in this project's local settings.`,
        'value',
        ERROR_CODES.VALIDATION_REQUIRED
      );
    }

    settings.permissions = {
      ...settings.permissions,
      [key]: current.filter((v) => v !== value),
    };
    writeJsonFile(filePath, settings);

    logger.info('Project permission revoked', { workingDirectory, kind, value });
    return this.list(workingDirectory);
  }

  private readEntries(filePath: string, source: ProjectPermissionSource): ProjectPermissionEntry[] {
    const permissions = readJsonFile<RawSettings>(filePath).permissions;

    const rules = this.toStrings(permissions?.allow).map((value): ProjectPermissionEntry => {
      const match = RULE_PATTERN.exec(value);
      return match
        ? { kind: 'rule', value, toolName: match[1], ruleContent: match[2], source }
        : { kind: 'rule', value, toolName: value, source };
    });
    const directories = this.toStrings(permissions?.additionalDirectories).map(
      (value): ProjectPermissionEntry => ({ kind: 'directory', value, source })
    );

    return [...rules, ...directories];
  }

  /** Hand-edited files can hold anything; keep only the string entries. */
  private toStrings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }
}

export default ProjectPermissionService;
