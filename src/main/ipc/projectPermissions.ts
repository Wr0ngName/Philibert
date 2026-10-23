/**
 * IPC handlers for project-scoped tool permissions
 * (`.claude/settings.local.json` and `.claude/settings.json`).
 */

import { ipcMain } from 'electron';

import { IPC_CHANNELS, type ProjectPermissionEntry } from '../../shared/types';
import { ValidationError, ERROR_CODES } from '../errors';
import ProjectPermissionService from '../services/ProjectPermissionService';
import { validateString, validatePath, ensureService, toSettingsIpcError } from '../utils/ipc-helpers';
import logger from '../utils/logger';

const ENTRY_KINDS: ReadonlyArray<ProjectPermissionEntry['kind']> = ['rule', 'directory'];

export function setupProjectPermissionsIPC(projectPermissionService: ProjectPermissionService): void {
  const requireProject = (workingDirectory: unknown): string => {
    validateString(workingDirectory, 'Working directory');
    validatePath(workingDirectory);
    return workingDirectory;
  };

  ipcMain.handle(IPC_CHANNELS.CLAUDE_GET_PROJECT_PERMISSIONS, async (_event, workingDirectory: string) => {
    try {
      ensureService(projectPermissionService, 'ProjectPermissionService');
      return projectPermissionService.list(requireProject(workingDirectory));
    } catch (error) {
      logger.error('Failed to list project permissions', { error });
      throw toSettingsIpcError('Failed to read the project permissions', error);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_REVOKE_PROJECT_PERMISSION,
    async (_event, workingDirectory: string, kind: ProjectPermissionEntry['kind'], value: string) => {
      try {
        ensureService(projectPermissionService, 'ProjectPermissionService');
        if (!ENTRY_KINDS.includes(kind)) {
          throw new ValidationError(`Unknown permission kind: ${String(kind)}`, 'kind', ERROR_CODES.VALIDATION_TYPE_MISMATCH);
        }
        validateString(value, 'Permission');
        return projectPermissionService.revoke(requireProject(workingDirectory), kind, value);
      } catch (error) {
        logger.error('Failed to revoke project permission', { error, kind, value });
        throw toSettingsIpcError('Failed to revoke the project permission', error);
      }
    }
  );

  logger.info('Project permissions IPC handlers registered');
}
