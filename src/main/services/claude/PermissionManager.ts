/**
 * Permission Manager for Claude Code SDK
 *
 * Handles tool permission requests and user approval flow.
 * Extracted from ClaudeCodeService for better separation of concerns.
 */

import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';

import { generateId, ID_PREFIXES } from '../../../shared/id';
import { PendingAction, ActionResponse, PermissionSuggestionInfo, PermissionScope, PermissionScopeOption, PermissionContext } from '../../../shared/types';
import { MAIN_CONSTANTS } from '../../constants/app';
import logger from '../../utils/logger';
import type ConfigService from '../ConfigService';

import type { SessionPermissionCache } from './SessionPermissionCache';

/**
 * Internal representation of a pending permission request
 */
interface PendingPermission {
  actionId: string;
  toolName: string;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
  suggestions?: PermissionUpdate[];
  /** Cleanup function to remove the abort event listener */
  cleanupAbortHandler?: () => void;
}

/**
 * Callback for emitting tool use events to the renderer
 */
type ToolUseEmitter = (action: PendingAction) => void;

/**
 * Callback for notifying the renderer that a tool execution started (auto-approved)
 */
type ToolExecutedEmitter = (actionId: string) => void;

/**
 * Manages tool permission requests and user approval flow
 */
export class PermissionManager {
  private configService: ConfigService;
  private pendingPermissions: Map<string, PendingPermission> = new Map();
  private emitToolUse: ToolUseEmitter;
  private emitToolExecuted?: ToolExecutedEmitter;

  constructor(
    configService: ConfigService,
    emitToolUse: ToolUseEmitter,
    private sessionPermissionCache?: SessionPermissionCache,
    private conversationId?: string,
    emitToolExecuted?: ToolExecutedEmitter,
  ) {
    this.configService = configService;
    this.emitToolUse = emitToolUse;
    this.emitToolExecuted = emitToolExecuted;
  }

  /**
   * Create the canUseTool callback for custom permission handling
   * This is called by the SDK when Claude wants to use a tool
   */
  createCanUseToolCallback(): CanUseTool {
    return async (toolName, input, options): Promise<PermissionResult> => {
      const actionId = generateId(ID_PREFIXES.ACTION);

      logger.info('Tool permission requested', { actionId, toolName, input });

      // Check if operation was aborted
      if (options.signal.aborted) {
        return {
          behavior: 'deny',
          message: 'Operation was cancelled',
          interrupt: true,
        };
      }

      // Auto-approve read operations if configured
      const config = await this.configService.getConfig();
      if (config.autoApproveReads && this.isReadOnlyTool(toolName)) {
        logger.debug('Auto-approving read operation', { toolName });
        return {
          behavior: 'allow',
          updatedInput: input,
        };
      }

      // Check session permission cache (persists across queries)
      if (this.sessionPermissionCache && this.conversationId) {
        if (this.sessionPermissionCache.isAllowed(this.conversationId, toolName, input)) {
          logger.debug('Session permission cache hit', { toolName, conversationId: this.conversationId });
          return {
            behavior: 'allow',
            updatedInput: input,
          };
        }
      }

      // Create pending action for UI (include permission info from SDK suggestions)
      const permissionInfo = this.describePermissionSuggestions(toolName, options.suggestions);
      const permissionContext: PermissionContext | undefined =
        (options.blockedPath || options.decisionReason)
          ? {
            blockedPath: options.blockedPath,
            decisionReason: options.decisionReason,
          }
          : undefined;
      const action = this.createPendingAction(actionId, toolName, input, permissionInfo, permissionContext);
      if (!action) {
        logger.warn('Could not create action for tool', { toolName });
        return {
          behavior: 'deny',
          message: `Unknown tool: ${toolName}`,
        };
      }

      // Send to renderer for user approval
      this.emitToolUse(action);

      // Create promise that will be resolved when user responds
      return new Promise<PermissionResult>((resolve, reject) => {
        const pendingPermission: PendingPermission = {
          actionId,
          toolName,
          input,
          resolve,
          reject,
          suggestions: options.suggestions,
        };

        // Set up named abort handler so it can be removed after resolution
        const abortHandler = () => {
          const pending = this.pendingPermissions.get(actionId);
          if (pending) {
            this.pendingPermissions.delete(actionId);
            resolve({
              behavior: 'deny',
              message: 'Operation was cancelled',
              interrupt: true,
            });
          }
        };

        pendingPermission.cleanupAbortHandler = () => {
          // Guard: signal may not support removeEventListener in test environments
          if (typeof options.signal.removeEventListener === 'function') {
            options.signal.removeEventListener('abort', abortHandler);
          }
        };

        this.pendingPermissions.set(actionId, pendingPermission);
        options.signal.addEventListener('abort', abortHandler);

        // Timeout after configured duration (SDK requirement)
        setTimeout(() => {
          const pending = this.pendingPermissions.get(actionId);
          if (pending) {
            this.pendingPermissions.delete(actionId);
            logger.warn('Permission request timed out', { actionId });
            resolve({
              behavior: 'deny',
              message: 'Permission request timed out',
              interrupt: false,
            });
          }
        }, MAIN_CONSTANTS.CLAUDE.PERMISSION_TIMEOUT_MS);
      });
    };
  }

  /**
   * Check if a tool is read-only (safe to auto-approve)
   */
  private isReadOnlyTool(toolName: string): boolean {
    const readOnlyTools = ['Read', 'Glob', 'Grep', 'LS', 'ListFiles'];
    return readOnlyTools.includes(toolName);
  }

  /**
   * Map SDK PermissionUpdateDestination to our PermissionScope.
   * Defaults to 'session' for unknown destinations (defensive).
   */
  private mapDestinationToScope(destination: string): PermissionScope {
    switch (destination) {
      case 'userSettings':
        return 'global';
      case 'projectSettings':
      case 'localSettings':
        return 'project';
      case 'session':
      case 'cliArg':
      default:
        return 'session';
    }
  }

  /**
   * Parse SDK permission suggestions into per-scope options
   * for display in the action approval UI.
   *
   * Groups suggestions by scope and creates a button option for each:
   * - 'session' → session scope (temporary, this session only)
   * - 'projectSettings' / 'localSettings' → project scope (stored per project)
   * - 'userSettings' → global scope (stored in user settings, applies everywhere)
   */
  private describePermissionSuggestions(
    toolName: string,
    suggestions?: PermissionUpdate[]
  ): PermissionSuggestionInfo | undefined {
    if (!suggestions || suggestions.length === 0) {
      return undefined;
    }

    const SCOPE_PRIORITY: Record<PermissionScope, number> = { session: 0, project: 1, global: 2 };
    const SCOPE_LABELS: Record<PermissionScope, string> = {
      session: 'for this session',
      project: 'for this project',
      global: 'globally',
    };

    // Group suggestions by scope, collecting tool names, rule conditions, and directories per scope
    const scopeGroups: Record<PermissionScope, {
      toolNames: Set<string>;
      ruleDetails: string[];    // e.g., 'Bash: command contains "git"'
      directories: string[];    // e.g., '/home/user/project'
      descriptions: string[];   // Full human-readable descriptions
    }> = {
      session: { toolNames: new Set(), ruleDetails: [], directories: [], descriptions: [] },
      project: { toolNames: new Set(), ruleDetails: [], directories: [], descriptions: [] },
      global: { toolNames: new Set(), ruleDetails: [], directories: [], descriptions: [] },
    };

    // Also track globally for legacy fields
    const allToolNames = new Set<string>();
    let broadestScope: PermissionScope = 'session';

    for (const suggestion of suggestions) {
      const scope = this.mapDestinationToScope(suggestion.destination);
      const group = scopeGroups[scope];

      if (SCOPE_PRIORITY[scope] > SCOPE_PRIORITY[broadestScope]) {
        broadestScope = scope;
      }

      if (suggestion.type === 'addRules' || suggestion.type === 'replaceRules' || suggestion.type === 'removeRules') {
        for (const rule of suggestion.rules) {
          group.toolNames.add(rule.toolName);
          allToolNames.add(rule.toolName);
          if (rule.ruleContent) {
            group.ruleDetails.push(`${rule.toolName}: ${rule.ruleContent}`);
          }
        }
        if (suggestion.type === 'addRules') {
          const ruleDescParts = suggestion.rules.map((r) =>
            r.ruleContent ? `${r.toolName} (${r.ruleContent})` : r.toolName
          );
          group.descriptions.push(`Allow ${ruleDescParts.join(', ')} ${SCOPE_LABELS[scope]}`);
        }
      } else if (suggestion.type === 'addDirectories') {
        group.directories.push(...suggestion.directories);
        const dirs = suggestion.directories.join(', ');
        group.descriptions.push(`Add directories: ${dirs}`);
      } else if (suggestion.type === 'setMode') {
        group.descriptions.push(`Set mode: ${suggestion.mode}`);
      }
    }

    // If no tool names found in any rules, use the requesting tool name
    if (allToolNames.size === 0) {
      allToolNames.add(toolName);
      // Add to each non-empty scope group as well
      for (const scope of (['session', 'project', 'global'] as PermissionScope[])) {
        if (scopeGroups[scope].descriptions.length > 0) {
          scopeGroups[scope].toolNames.add(toolName);
        }
      }
    }

    // Build per-scope options (only for scopes that have suggestions)
    const scopeOptions: PermissionScopeOption[] = [];
    const SCOPE_ORDER: PermissionScope[] = ['session', 'project', 'global'];

    for (const scope of SCOPE_ORDER) {
      const group = scopeGroups[scope];
      // A scope has content if it has tool names or descriptions
      const hasSuggestions = suggestions.some(
        (s) => this.mapDestinationToScope(s.destination) === scope
      );

      if (!hasSuggestions) continue;

      const scopeToolNames = group.toolNames.size > 0 ? group.toolNames : allToolNames;
      const toolLabel = scopeToolNames.size === 1 ? [...scopeToolNames][0] : `${scopeToolNames.size} tools`;

      // Build label: include rule conditions and directory paths for clarity
      let label: string;
      const hasRuleDetails = group.ruleDetails.length > 0;
      const hasDirectories = group.directories.length > 0;

      // For button labels with conditions: "Allow Bash (command contains 'git') in project"
      let detailSuffix = '';
      if (hasRuleDetails && scopeToolNames.size === 1) {
        // Single tool with rule content — show the condition
        const firstRule = group.ruleDetails[0];
        const ruleContent = firstRule.substring(firstRule.indexOf(':') + 2);
        detailSuffix = ` (${ruleContent})`;
      }
      if (hasDirectories) {
        const dirList = group.directories.length <= 2
          ? group.directories.join(', ')
          : `${group.directories.length} directories`;
        detailSuffix += detailSuffix ? ` + ${dirList}` : ` (${dirList})`;
      }

      switch (scope) {
        case 'session':
          label = `Allow ${toolLabel}${detailSuffix} this session`;
          break;
        case 'project':
          label = `Allow ${toolLabel}${detailSuffix} in project`;
          break;
        case 'global':
          label = `Always allow ${toolLabel}${detailSuffix}`;
          break;
      }

      const description = group.descriptions.length > 0
        ? group.descriptions.join('; ')
        : `Allow ${toolLabel} (${scope} scope)`;

      scopeOptions.push({ scope, label, description });
    }

    // Legacy fields: broadest scope label
    const globalToolLabel = allToolNames.size === 1 ? [...allToolNames][0] : `${allToolNames.size} tools`;
    let alwaysAllowLabel: string;
    switch (broadestScope) {
      case 'session':
        alwaysAllowLabel = `Allow ${globalToolLabel} this session`;
        break;
      case 'project':
        alwaysAllowLabel = `Allow ${globalToolLabel} in this project`;
        break;
      case 'global':
        alwaysAllowLabel = `Always allow ${globalToolLabel}`;
        break;
    }

    const allDescriptions = Object.values(scopeGroups).flatMap((g) => g.descriptions);
    const description = allDescriptions.length > 0
      ? allDescriptions.join('; ')
      : `Allow ${globalToolLabel} (${broadestScope} scope)`;

    return {
      alwaysAllowLabel,
      description,
      scope: broadestScope,
      scopeOptions,
    };
  }

  /**
   * Create a PendingAction from tool info for UI display
   */
  private createPendingAction(
    actionId: string,
    toolName: string,
    input: Record<string, unknown>,
    permissionInfo?: PermissionSuggestionInfo,
    permissionContext?: PermissionContext,
  ): PendingAction | null {
    const baseFields = {
      id: actionId,
      toolName,
      input,
      status: 'pending' as const,
      timestamp: Date.now(),
      ...(permissionInfo ? { permissionInfo } : {}),
      ...(permissionContext ? { permissionContext } : {}),
    };

    switch (toolName) {
      case 'Edit':
        return {
          ...baseFields,
          type: 'file-edit' as const,
          description: `Edit file: ${input.file_path}`,
          details: {
            filePath: input.file_path as string,
            originalContent: input.old_string as string | undefined,
            newContent: input.new_string as string,
          },
        };

      case 'Write':
        return {
          ...baseFields,
          type: 'file-create' as const,
          description: `Write file: ${input.file_path}`,
          details: {
            filePath: input.file_path as string,
            content: input.content as string,
          },
        };

      case 'Bash': {
        const cmd = input.command as string;
        return {
          ...baseFields,
          type: 'bash-command' as const,
          description: `Run command: ${cmd.length > 50 ? cmd.slice(0, 50) + '...' : cmd}`,
          details: {
            command: cmd,
            workingDirectory: (input.cwd as string) || '',
          },
        };
      }

      case 'Read':
        return {
          ...baseFields,
          type: 'read-file' as const,
          description: `Read file: ${input.file_path}`,
          details: {
            filePath: input.file_path as string,
          },
        };

      case 'Glob':
        return {
          ...baseFields,
          type: 'read-file' as const,
          description: `Search files: ${input.pattern}`,
          details: {
            filePath: (input.path as string) || '.',
          },
        };

      case 'Grep':
        return {
          ...baseFields,
          type: 'read-file' as const,
          description: `Search content: ${input.pattern}`,
          details: {
            filePath: (input.path as string) || '.',
          },
        };

      default:
        // Handle unknown tools generically
        return {
          ...baseFields,
          type: 'bash-command' as const,
          description: `Tool: ${toolName}`,
          details: {
            command: JSON.stringify(input),
            workingDirectory: '',
          },
        };
    }
  }

  /**
   * Filter suggestions to those matching a chosen scope.
   * When a broader scope is chosen, also includes narrower scope suggestions
   * (e.g., choosing "project" also includes "session" suggestions, since
   * session permissions aren't persisted to disk by the SDK).
   */
  private filterSuggestionsByScope(
    suggestions: PermissionUpdate[],
    chosenScope: PermissionScope
  ): PermissionUpdate[] {
    const SCOPE_PRIORITY: Record<PermissionScope, number> = { session: 0, project: 1, global: 2 };
    const chosenPriority = SCOPE_PRIORITY[chosenScope];

    return suggestions.filter((s) => {
      const suggestionScope = this.mapDestinationToScope(s.destination);
      // Include suggestions at the chosen scope or narrower
      return SCOPE_PRIORITY[suggestionScope] <= chosenPriority;
    });
  }

  /**
   * Handle action response from renderer (approve/reject)
   */
  handleActionResponse(response: ActionResponse): void {
    const pending = this.pendingPermissions.get(response.actionId);
    if (!pending) {
      logger.warn('No pending permission found for action', { actionId: response.actionId });
      return;
    }

    this.pendingPermissions.delete(response.actionId);

    // Clean up the abort event listener to prevent memory leaks
    pending.cleanupAbortHandler?.();

    if (response.approved) {
      logger.info('Action approved by user', {
        actionId: response.actionId,
        toolName: pending.toolName,
        alwaysAllow: response.alwaysAllow,
        chosenScope: response.chosenScope,
      });

      const result: PermissionResult = {
        behavior: 'allow',
        updatedInput: response.updatedInput || pending.input,
      };

      // Include permission updates if user chose "always allow"
      if (response.alwaysAllow && pending.suggestions) {
        // Filter suggestions by chosen scope if specified
        const filteredSuggestions = response.chosenScope
          ? this.filterSuggestionsByScope(pending.suggestions, response.chosenScope)
          : pending.suggestions;

        result.updatedPermissions = filteredSuggestions;

        // Cache session-scoped permissions for persistence across queries
        // (SessionPermissionCache internally filters to session/cliArg destinations only)
        if (this.sessionPermissionCache && this.conversationId) {
          this.sessionPermissionCache.addPermissions(this.conversationId, filteredSuggestions);
        }
      }

      pending.resolve(result);

      // Auto-resolve other pending permissions now covered by the updated cache
      if (response.alwaysAllow && this.sessionPermissionCache && this.conversationId) {
        this.autoResolveCachedPermissions();
      }
    } else {
      logger.info('Action rejected by user', {
        actionId: response.actionId,
        toolName: pending.toolName,
        message: response.denyMessage,
      });

      pending.resolve({
        behavior: 'deny',
        message: response.denyMessage || 'User rejected this action',
        interrupt: !response.denyMessage, // Interrupt if no guidance provided
      });
    }
  }

  /**
   * Auto-resolve any pending permissions that are now covered by the session cache.
   * Called after an "always allow" approval updates the cache.
   */
  private autoResolveCachedPermissions(): void {
    const toResolve: PendingPermission[] = [];

    for (const [actionId, pending] of this.pendingPermissions) {
      if (this.sessionPermissionCache!.isAllowed(this.conversationId!, pending.toolName, pending.input)) {
        toResolve.push(pending);
        this.pendingPermissions.delete(actionId);
      }
    }

    for (const pending of toResolve) {
      pending.cleanupAbortHandler?.();
      logger.info('Auto-resolved pending permission from cache', {
        actionId: pending.actionId,
        toolName: pending.toolName,
      });
      pending.resolve({
        behavior: 'allow',
        updatedInput: pending.input,
      });
      this.emitToolExecuted?.(pending.actionId);
    }
  }

  /**
   * Clear all pending permissions (e.g., on abort)
   */
  clearPendingPermissions(): void {
    for (const [, pending] of this.pendingPermissions) {
      pending.cleanupAbortHandler?.();
      pending.resolve({
        behavior: 'deny',
        message: 'Operation was cancelled',
        interrupt: true,
      });
    }
    this.pendingPermissions.clear();
  }

  /**
   * Get the number of pending permissions
   */
  getPendingCount(): number {
    return this.pendingPermissions.size;
  }
}

export default PermissionManager;
