/**
 * Type definitions for the preload API exposed to the renderer
 */

import type {
  ActionResponse,
  AppConfig,
  AskUserQuestionResponse,
  AuthStatus,
  Conversation,
  FileChange,
  FileNode,
  GitBranch,
  GitStatus,
  ModelInfo,
  PendingAction,
  PermissionScope,
  SessionPermissionEntry,
  SessionUsage,
  SlashCommandInfo,
  TaskNotification,
  ToolCaptureData,
  ToolResultData,
  UpdateInfo,
  UpdateProgress,
} from './types';

/** Active query status info */
export interface ActiveQueryStatus {
  count: number;
  maxCount: number;
  processingCount: number;
  activeConversationIds: string[];
}

export interface ElectronAPI {
  // Claude operations
  claude: {
    /** Send a message to Claude for a specific conversation */
    send: (conversationId: string, message: string, workingDir: string, resumeSessionId?: string) => Promise<void>;
    /** Approve a pending action for a specific conversation */
    approve: (
      conversationId: string,
      actionId: string,
      updatedInput?: Record<string, unknown>,
      alwaysAllow?: boolean,
      chosenScope?: PermissionScope
    ) => Promise<void>;
    /** Reject a pending action for a specific conversation */
    reject: (conversationId: string, actionId: string, message?: string) => Promise<void>;
    /** Deliver the user's answer (or cancellation) for a pending AskUserQuestion */
    answerQuestion: (response: AskUserQuestionResponse) => Promise<void>;
    /** Send full action response (includes conversationId in response object) */
    respondToAction: (response: ActionResponse) => Promise<void>;
    /** Abort the request for a specific conversation */
    abort: (conversationId: string) => Promise<void>;
    /** Get available slash commands */
    getCommands: () => Promise<SlashCommandInfo[]>;
    /** Get available models */
    getModels: () => Promise<ModelInfo[]>;
    /** Get current active query status */
    getActiveQueries: () => Promise<ActiveQueryStatus>;
    /** Message chunk received for a conversation */
    onChunk: (callback: (conversationId: string, chunk: string) => void) => () => void;
    /** Tool use requested for a conversation */
    onToolUse: (callback: (conversationId: string, action: PendingAction) => void) => () => void;
    /** Error occurred for a conversation */
    onError: (callback: (conversationId: string, error: string) => void) => () => void;
    /** Request completed for a conversation */
    onDone: (callback: (conversationId: string) => void) => () => void;
    /** Slash commands updated for a conversation */
    onSlashCommands: (callback: (conversationId: string, commands: SlashCommandInfo[]) => void) => () => void;
    /** Command action triggered for a conversation */
    onCommandAction: (callback: (conversationId: string, action: string) => void) => () => void;
    /** Models changed */
    onModelsChanged: (callback: (models: ModelInfo[]) => void) => () => void;
    /** Background task notification for a conversation */
    onTaskNotification: (callback: (conversationId: string, notification: TaskNotification) => void) => () => void;
    /** Session usage updated for a conversation */
    onUsageUpdate: (callback: (conversationId: string, usage: SessionUsage) => void) => () => void;
    /** Active query count changed */
    onActiveQueriesChange: (callback: (count: number, maxCount: number, processingCount: number) => void) => () => void;
    /** System status note (compaction, model change) — rendered as separator */
    onSystemNote: (callback: (conversationId: string, note: string) => void) => () => void;
    /** SDK session ID received for a conversation (for resume support) */
    onSessionId: (callback: (conversationId: string, sessionId: string) => void) => () => void;
    /** Get session permissions for a conversation */
    getSessionPermissions: (conversationId: string) => Promise<SessionPermissionEntry[]>;
    /** Revoke a session permission */
    revokeSessionPermission: (conversationId: string, permissionId: string) => Promise<boolean>;
    /** Clear all session permissions for a conversation */
    clearSessionPermissions: (conversationId: string) => Promise<void>;
    /** Listen for session permission changes */
    onSessionPermissionsChanged: (callback: (conversationId: string, permissions: SessionPermissionEntry[]) => void) => () => void;
    /** Tool execution completed (approved and SDK proceeded) */
    onToolExecuted: (callback: (conversationId: string, actionId: string) => void) => () => void;
    /** Tool use captured from assistant message (all tools, including auto-approved) */
    onToolCapture: (callback: (conversationId: string, capture: ToolCaptureData) => void) => () => void;
    /** Tool result written to disk (output file path) */
    onToolResult: (callback: (conversationId: string, result: ToolResultData) => void) => () => void;
  };

  // Git operations
  git: {
    /** Get repository status */
    status: (workingDir: string) => Promise<GitStatus>;
    /**
     * Commit changes (optionally stage all first).
     * If `expectedBranch` is supplied, the main process verifies HEAD matches
     * before committing and rejects with a descriptive error otherwise.
     */
    commit: (
      workingDir: string,
      message: string,
      stageAll: boolean,
      expectedBranch?: string
    ) => Promise<string>;
    /**
     * Pull from remote. If `expectedBranch` is supplied, the main process
     * verifies HEAD matches before pulling and rejects otherwise.
     */
    pull: (workingDir: string, expectedBranch?: string) => Promise<string>;
    /**
     * Push to remote. If `expectedBranch` is supplied, the main process
     * verifies HEAD matches before pushing and rejects otherwise.
     */
    push: (workingDir: string, expectedBranch?: string) => Promise<string>;
    /** Fetch from remote (updates tracking refs for ahead/behind) */
    fetch: (workingDir: string) => Promise<void>;
    /** List local and remote-tracking branches */
    listBranches: (workingDir: string) => Promise<GitBranch[]>;
    /** Checkout an existing branch (or DWIM-create local tracking branch from a remote ref) */
    checkout: (workingDir: string, branchName: string) => Promise<string>;
    /** Create a new branch from HEAD (and optionally check it out) */
    createBranch: (workingDir: string, branchName: string, checkout: boolean) => Promise<string>;
    /** Read git's user.name / user.email config for this repo (falls through to global/system) */
    getIdentity: (workingDir: string) => Promise<{ name: string; email: string }>;
    /** Write user.name + user.email at the chosen scope ('local' = this repo, 'global' = ~/.gitconfig) */
    setIdentity: (workingDir: string, name: string, email: string, scope: 'local' | 'global') => Promise<void>;
    /** Listen for git status changes */
    onStatusChanged: (callback: (status: GitStatus) => void) => () => void;
  };

  // File operations
  files: {
    selectDirectory: () => Promise<string | null>;
    getTree: (directory: string) => Promise<FileNode[]>;
    read: (filePath: string) => Promise<string>;
    open: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    onChange: (callback: (changes: FileChange[]) => void) => () => void;
  };

  // Config operations
  config: {
    get: () => Promise<AppConfig>;
    set: (config: Partial<AppConfig>) => Promise<void>;
    onChange: (callback: (config: Partial<AppConfig>) => void) => () => void;
  };

  // Auth operations
  auth: {
    getStatus: () => Promise<AuthStatus>;
    startOAuth: () => Promise<{ authUrl: string; error?: string }>;
    completeOAuth: (code: string) => Promise<{ success: boolean; error?: string }>;
    logout: () => Promise<void>;
    onInvalidated: (callback: () => void) => () => void;
  };

  // Conversation operations
  conversation: {
    list: () => Promise<Conversation[]>;
    get: (id: string) => Promise<Conversation | null>;
    save: (conversation: Conversation) => Promise<void>;
    rename: (id: string, newTitle: string) => Promise<void>;
    delete: (id: string) => Promise<void>;
  };

  // Update operations
  update: {
    check: () => Promise<UpdateInfo | null>;
    download: () => Promise<void>;
    install: () => void;
    onAvailable: (callback: (info: UpdateInfo) => void) => () => void;
    onProgress: (callback: (progress: UpdateProgress) => void) => () => void;
    onDownloaded: (callback: () => void) => () => void;
  };

  // Window operations
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
  };

  // Platform info
  platform: string;
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
