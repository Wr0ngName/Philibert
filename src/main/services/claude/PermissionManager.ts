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
import {
  PendingAction,
  ActionResponse,
  PermissionSuggestionInfo,
  PermissionScope,
  PermissionScopeOption,
  PermissionContext,
  AskUserQuestionAction,
  AskUserQuestionDetails,
  AskUserQuestionEntry,
  AskUserQuestionOption,
  AskUserQuestionResponse,
  AskUserQuestionAnswer,
} from '../../../shared/types';
import logger from '../../utils/logger';
import type ConfigService from '../ConfigService';

import type { SessionPermissionCache } from './SessionPermissionCache';
import { parseGenericToolInput, buildGenericToolDescription } from './tool-input-parser';

/** Tool name for the SDK's built-in AskUserQuestion */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/** Prefix used by Claude Code for user messages that answer an AskUserQuestion */
export const ASK_USER_QUESTION_PREFIX = '[User answered AskUserQuestion]:';

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
 * Internal representation of a pending AskUserQuestion request.
 *
 * Unlike a normal permission, AskUserQuestion needs the user to *answer*, not
 * just allow/deny. We hold the canUseTool resolver until the answer arrives,
 * then short-circuit the tool execution with a synthetic result and inject a
 * follow-up `[User answered AskUserQuestion]:` user message — matching the
 * CLI's documented convention so the model treats the answer as direct user
 * intent.
 */
interface PendingQuestion {
  actionId: string;
  questions: AskUserQuestionEntry[];
  resolve: (result: PermissionResult) => void;
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
 * Callback for pushing a follow-up `[User answered AskUserQuestion]:` SDKUserMessage
 * into the conversation's input channel after the user answers a question.
 */
type AskUserQuestionFollowUpEmitter = (text: string) => void;

/**
 * Manages tool permission requests and user approval flow
 */
export class PermissionManager {
  private configService: ConfigService;
  private pendingPermissions: Map<string, PendingPermission> = new Map();
  private pendingQuestions: Map<string, PendingQuestion> = new Map();
  private emitToolUse: ToolUseEmitter;
  private emitToolExecuted?: ToolExecutedEmitter;
  private emitQuestionFollowUp?: AskUserQuestionFollowUpEmitter;

  constructor(
    configService: ConfigService,
    emitToolUse: ToolUseEmitter,
    private sessionPermissionCache?: SessionPermissionCache,
    private conversationId?: string,
    emitToolExecuted?: ToolExecutedEmitter,
    emitQuestionFollowUp?: AskUserQuestionFollowUpEmitter,
  ) {
    this.configService = configService;
    this.emitToolUse = emitToolUse;
    this.emitToolExecuted = emitToolExecuted;
    this.emitQuestionFollowUp = emitQuestionFollowUp;
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

      // AskUserQuestion intercept: surface the question in the UI and await
      // the user's answer. We short-circuit the SDK's built-in TTY renderer
      // (which would otherwise fail in the pipe-stdio SDK subprocess) and
      // inject the answer back via a `[User answered AskUserQuestion]:`
      // user message (CLI convention).
      if (toolName === ASK_USER_QUESTION_TOOL) {
        return this.handleAskUserQuestionRequest(actionId, input, options.signal);
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
      });
    };
  }

  /**
   * Surface an AskUserQuestion to the user and await their answer.
   *
   * Returns a PermissionResult that short-circuits the SDK's built-in
   * tool execution. We resolve the canUseTool promise with `behavior: 'deny'`
   * carrying a synthetic result that mirrors AskUserQuestionOutput so the
   * model has a structured tool_result to read. Independently, we push a
   * follow-up `[User answered AskUserQuestion]:` user message via the
   * emitQuestionFollowUp callback — matching the CLI convention so the
   * model treats the answer as direct user intent.
   */
  private handleAskUserQuestionRequest(
    actionId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const questions = this.parseAskUserQuestionInput(input);

    if (questions.length === 0) {
      logger.warn('AskUserQuestion called with no parseable questions', { input });
      return Promise.resolve({
        behavior: 'deny',
        message: 'AskUserQuestion was called with an invalid or empty questions payload.',
        interrupt: false,
      });
    }

    const details: AskUserQuestionDetails = {
      questions,
      truncated: false,
    };

    const action: AskUserQuestionAction = {
      id: actionId,
      type: 'ask-user-question',
      toolName: ASK_USER_QUESTION_TOOL,
      input,
      description: questions[0].question,
      status: 'pending',
      timestamp: Date.now(),
      details,
    };

    this.emitToolUse(action);

    return new Promise<PermissionResult>((resolve) => {
      const pending: PendingQuestion = {
        actionId,
        questions,
        resolve,
      };

      const abortHandler = () => {
        if (this.pendingQuestions.delete(actionId)) {
          resolve({
            behavior: 'deny',
            message: 'AskUserQuestion was cancelled.',
            interrupt: true,
          });
        }
      };

      pending.cleanupAbortHandler = () => {
        if (typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', abortHandler);
        }
      };

      this.pendingQuestions.set(actionId, pending);
      signal.addEventListener('abort', abortHandler);
    });
  }

  /**
   * Parse the raw AskUserQuestion input into validated, typed questions.
   * Silently drops malformed entries; returns an empty array if nothing is usable.
   */
  private parseAskUserQuestionInput(input: Record<string, unknown>): AskUserQuestionEntry[] {
    const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
    const out: AskUserQuestionEntry[] = [];

    for (const raw of rawQuestions) {
      if (!raw || typeof raw !== 'object') continue;
      const q = raw as Record<string, unknown>;

      const question = typeof q.question === 'string' ? q.question : '';
      const header = typeof q.header === 'string' ? q.header : '';
      const multiSelect = typeof q.multiSelect === 'boolean' ? q.multiSelect : false;
      const rawOptions = Array.isArray(q.options) ? q.options : [];
      if (!question || rawOptions.length === 0) continue;

      const options: AskUserQuestionOption[] = [];
      for (const rawOpt of rawOptions) {
        if (!rawOpt || typeof rawOpt !== 'object') continue;
        const opt = rawOpt as Record<string, unknown>;
        const label = typeof opt.label === 'string' ? opt.label : '';
        if (!label) continue;
        options.push({
          label,
          description: typeof opt.description === 'string' ? opt.description : '',
          ...(typeof opt.preview === 'string' && opt.preview ? { preview: opt.preview } : {}),
        });
      }
      if (options.length === 0) continue;

      out.push({ question, header, multiSelect, options });
    }

    return out;
  }

  /**
   * Handle the user's answer to an AskUserQuestion.
   *
   * Returns true if an answer was applied, false if the actionId wasn't pending
   * (e.g. already cancelled).
   */
  handleQuestionAnswer(response: AskUserQuestionResponse): boolean {
    const pending = this.pendingQuestions.get(response.actionId);
    if (!pending) {
      logger.warn('No pending question for action', { actionId: response.actionId });
      return false;
    }

    this.pendingQuestions.delete(response.actionId);
    pending.cleanupAbortHandler?.();

    if (response.cancelled) {
      logger.info('User cancelled AskUserQuestion', { actionId: response.actionId });
      pending.resolve({
        behavior: 'deny',
        message: 'User cancelled the question.',
        interrupt: false,
      });
      return true;
    }

    const syntheticResult = this.buildSyntheticQuestionResult(pending.questions, response.answers);

    logger.info('User answered AskUserQuestion', {
      actionId: response.actionId,
      answerCount: response.answers.length,
    });

    // Resolve canUseTool with deny + structured payload so the model has a
    // tool_result even though we suppressed the built-in tool execution.
    pending.resolve({
      behavior: 'deny',
      message: JSON.stringify(syntheticResult),
      interrupt: false,
    });

    // Inject the prefixed user message so the model treats the answer as
    // direct user intent (CLI convention from `[User answered AskUserQuestion]:`).
    if (this.emitQuestionFollowUp) {
      const followUp = this.formatFollowUpMessage(pending.questions, response.answers);
      this.emitQuestionFollowUp(followUp);
    }

    return true;
  }

  /**
   * Build the synthetic AskUserQuestionOutput-shaped payload returned as the
   * tool_result (via canUseTool deny message). Mirrors the SDK's
   * AskUserQuestionOutput type.
   */
  private buildSyntheticQuestionResult(
    questions: AskUserQuestionEntry[],
    answers: AskUserQuestionAnswer[],
  ): {
    questions: AskUserQuestionEntry[];
    answers: Record<string, string>;
    annotations?: Record<string, { preview?: string; notes?: string }>;
  } {
    const answersMap: Record<string, string> = {};
    const annotations: Record<string, { preview?: string; notes?: string }> = {};

    for (const a of answers) {
      answersMap[a.question] = a.answer;
      if (a.preview || a.notes) {
        annotations[a.question] = {
          ...(a.preview ? { preview: a.preview } : {}),
          ...(a.notes ? { notes: a.notes } : {}),
        };
      }
    }

    const result: ReturnType<PermissionManager['buildSyntheticQuestionResult']> = {
      questions,
      answers: answersMap,
    };
    if (Object.keys(annotations).length > 0) {
      result.annotations = annotations;
    }
    return result;
  }

  /**
   * Format the `[User answered AskUserQuestion]:` follow-up user message.
   *
   * For a single question, uses a compact `<question>: <answer>` form.
   * For multiple questions, lists each on its own line.
   */
  private formatFollowUpMessage(
    questions: AskUserQuestionEntry[],
    answers: AskUserQuestionAnswer[],
  ): string {
    const answeredByQuestion = new Map(answers.map((a) => [a.question, a]));
    const lines: string[] = [];

    for (const q of questions) {
      const a = answeredByQuestion.get(q.question);
      if (!a) continue;
      const note = a.notes ? ` (${a.notes})` : '';
      lines.push(`${q.question} ${a.answer}${note}`);
    }

    const body = lines.length === 0
      ? '(user provided no answer)'
      : lines.length === 1
        ? lines[0]
        : lines.map((l) => `- ${l}`).join('\n');

    return `${ASK_USER_QUESTION_PREFIX} ${body}`;
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
      return {
        alwaysAllowLabel: `Allow ${toolName} this session`,
        description: `Allow ${toolName} for this session`,
        scope: 'session' as PermissionScope,
        scopeOptions: [{
          scope: 'session' as PermissionScope,
          label: `Allow ${toolName} this session`,
          description: `Allow ${toolName} for this session`,
        }],
      };
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

    // Ensure a session scope option always exists (for tools where SDK only provides project/global)
    if (!scopeOptions.some(o => o.scope === 'session')) {
      scopeOptions.unshift({
        scope: 'session',
        label: `Allow ${toolName} this session`,
        description: `Allow ${toolName} for this session`,
      });
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

    // Defense-in-depth: AskUserQuestion must always be routed through
    // handleAskUserQuestionRequest, never built as a generic permission
    // dialog. If we reach this point with AskUserQuestion the intercept
    // was bypassed — return null so the caller surfaces a clean error
    // instead of showing a misleading "Tool: AskUserQuestion" prompt.
    if (toolName === ASK_USER_QUESTION_TOOL) {
      logger.error('createPendingAction reached with AskUserQuestion — intercept was bypassed', {
        actionId,
      });
      return null;
    }

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

      default: {
        // Generic rendering for tools without a dedicated card (MCP tools,
        // Task, WebFetch, etc.). The old behaviour was to dump
        // `JSON.stringify(input)` into a bash-command card, which mangled
        // multi-line commands and buried the input.description.
        const details = parseGenericToolInput(input);
        return {
          ...baseFields,
          type: 'generic-tool' as const,
          description: buildGenericToolDescription(toolName, details),
          details,
        };
      }
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
      if (response.alwaysAllow && pending.suggestions && pending.suggestions.length > 0) {
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

      // Ensure session permission is cached even when SDK provided no session-scoped suggestions.
      // This covers tools like WebSearch, WebFetch where the SDK may not offer session rules.
      // addDirectPermission is idempotent (skips duplicates from SDK-provided entries above).
      if (response.alwaysAllow && response.chosenScope === 'session' && this.sessionPermissionCache && this.conversationId) {
        this.sessionPermissionCache.addDirectPermission(this.conversationId, pending.toolName);
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

    for (const [, pending] of this.pendingQuestions) {
      pending.cleanupAbortHandler?.();
      pending.resolve({
        behavior: 'deny',
        message: 'AskUserQuestion was cancelled.',
        interrupt: true,
      });
    }
    this.pendingQuestions.clear();
  }

  /**
   * Get the number of pending permissions (questions + standard approvals)
   */
  getPendingCount(): number {
    return this.pendingPermissions.size + this.pendingQuestions.size;
  }
}

export default PermissionManager;
