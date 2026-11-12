/**
 * Type definitions for the preload API exposed to the renderer
 */

import type { ModelDownloadProgress } from './speech';
import type {
  ChatMessage,
  MessageImage,
  ImageMediaType,
  AboutInfo,
  ActionResponse,
  AppConfig,
  AskUserQuestionResponse,
  AuthStatus,
  AutoArchiveDays,
  ConversationListPage,
  ConversationListRequest,
  ConversationSummary,
  RestoredUsageLimitWaits,
  UsageLimitWait,
  ConversationSearchResult,
  ConversationSearchScope,
  FileChange,
  FileChanges,
  FileNode,
  GitBranch,
  GitCredentialAnswer,
  GitCredentialRequest,
  GitRemoteResult,
  GitStatus,
  GlobalTools,
  ProjectTools,
  McpCommandCheck,
  McpRuntimeInfo,
  McpServerEntry,
  McpServerInput,
  ModelInfo,
  PendingAction,
  PromptDeliveryState,
  PermissionOptionVariant,
  PermissionScope,
  ProjectPermissionEntry,
  SessionPermissionEntry,
  DiscussionSettings,
  SessionRetention,
  SessionSchedule,
  SessionUsage,
  AgentInfo,
  RewindOutcome,
  RewindPreview,
  RewindScope,
  SlashCommandInfo,
  LiveBackgroundTask,
  TaskNotification,
  ToolCaptureData,
  ToolResultData,
  UpdateInfo,
  UpdateInstallResult,
  UpdateProgress,
  TaskOutputChunk,
  UsageLimitStop,
  UsageWarning,
  WhisperModelId,
  ConversationUpdate,
  ConversationWindow,
  RendererLogEntry,
  ClaudeAccount,
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
    /**
     * Send a message to Claude for a specific conversation. Resolves to the
     * uuid it was sent under — the CLI files the turn's file checkpoint under
     * it, so it is the turn's rewind target — or null when it did not go to
     * the CLI as a message of ours.
     */
    send: (
      conversationId: string,
      message: string,
      workingDir: string,
      resumeSessionId: string | undefined,
      /**
       * Images the user attached, as references. The bytes were stored when
       * they were attached, so they cross IPC once rather than on every send;
       * the main process reads them back to build the image content blocks.
       */
      images: MessageImage[] | undefined,
      /** The discussion's own model, effort and thinking mode. */
      settings: DiscussionSettings,
    ) => Promise<string | null>;
    /**
     * Send a message into the turn running now, for Claude to read at its
     * next step. Resolves to the message's uuid, whose fate arrives through
     * onPromptDelivery; null when no turn is running for it to join.
     */
    sendDuringTurn: (conversationId: string, message: string, images?: MessageImage[]) => Promise<string | null>;
    /**
     * Take back a message sent into the running turn, while Claude has not
     * read it. Resolves to whether it was taken back: false once Claude has it.
     */
    cancelDuringTurn: (conversationId: string, uuid: string) => Promise<boolean>;
    /** What became of a message sent during a turn. */
    onPromptDelivery: (
      callback: (conversationId: string, uuid: string, state: PromptDeliveryState) => void,
    ) => () => void;
    /** Approve a pending action for a specific conversation */
    approve: (
      conversationId: string,
      actionId: string,
      updatedInput?: Record<string, unknown>,
      alwaysAllow?: boolean,
      chosenScope?: PermissionScope,
      chosenVariant?: PermissionOptionVariant
    ) => Promise<void>;
    /** Reject a pending action for a specific conversation */
    reject: (conversationId: string, actionId: string, message?: string) => Promise<void>;
    /** Deliver the user's answer (or cancellation) for a pending AskUserQuestion */
    answerQuestion: (response: AskUserQuestionResponse) => Promise<void>;
    /** Send full action response (includes conversationId in response object) */
    respondToAction: (response: ActionResponse) => Promise<void>;
    /** Abort the request for a specific conversation */
    abort: (conversationId: string) => Promise<void>;
    /** Stop one running background task without ending the turn */
    stopTask: (conversationId: string, taskId: string) => Promise<void>;
    /**
     * A background task's output from `fromByte` on (its tail, when that is
     * more than the cap), or null when it has none to read yet.
     */
    readTaskOutput: (
      conversationId: string,
      taskId: string,
      sdkSessionId: string | undefined,
      fromByte: number,
    ) => Promise<TaskOutputChunk | null>;
    /** An agent task's transcript, as chat messages. */
    getAgentTranscript: (conversationId: string, agentId: string, sdkSessionId: string | undefined) => Promise<ChatMessage[]>;
    /** Get available slash commands */
    getCommands: () => Promise<SlashCommandInfo[]>;
    /** Subagents this session can delegate to, from the SDK. */
    getAgents: () => Promise<AgentInfo[]>;
    /** What a rewind to this user turn would restore. Changes nothing. */
    previewRewind: (conversationId: string, messageUuid: string) => Promise<RewindPreview>;
    /** Restore files and/or the conversation to this user turn. */
    applyRewind: (
      conversationId: string,
      messageUuid: string,
      scope: RewindScope,
    ) => Promise<RewindOutcome>;
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
    /** The CLI started a turn nobody sent, its answer to a background task finishing */
    onTurnStarted: (callback: (conversationId: string) => void) => () => void;
    /** Slash commands updated for a conversation */
    onSlashCommands: (callback: (conversationId: string, commands: SlashCommandInfo[]) => void) => () => void;
    /** Models changed */
    onModelsChanged: (callback: (models: ModelInfo[]) => void) => () => void;
    /** The model the CLI reports it is actually running for a conversation */
    onActiveModel: (callback: (conversationId: string, model: string) => void) => () => void;
    /** Model and token spend attributed to a background agent */
    onSubagentActivity: (callback: (conversationId: string, activity: { parentToolUseId: string; model?: string; inputTokens: number; outputTokens: number }) => void) => () => void;
    /** Background task notification for a conversation */
    onTaskNotification: (callback: (conversationId: string, notification: TaskNotification) => void) => () => void;
    /**
     * The SDK's authoritative live background-task set for a conversation.
     * REPLACE semantics — the payload is every live task, so anything tracked
     * locally and absent from it has ended.
     */
    onBackgroundTasksChanged: (callback: (conversationId: string, tasks: LiveBackgroundTask[]) => void) => () => void;
    /** Session usage updated for a conversation */
    onUsageUpdate: (callback: (conversationId: string, usage: SessionUsage) => void) => () => void;
    /** Active query count changed */
    /**
     * Active-query status changed. `activeConversationIds` is the authoritative
     * set of conversations mid-turn, so the renderer can correct a busy flag
     * that a missed or misattributed CLAUDE_DONE left wrong.
     */
    onActiveQueriesChange: (
      callback: (
        count: number,
        maxCount: number,
        processingCount: number,
        activeConversationIds: string[],
      ) => void,
    ) => () => void;
    /** System status note (compaction, model change) — rendered as separator */
    onSystemNote: (callback: (conversationId: string, note: string) => void) => () => void;
    /** A turn was stopped by a claude.ai usage limit with a known reset time */
    onUsageLimit: (callback: (conversationId: string, stop: UsageLimitStop) => void) => () => void;
    /** A claude.ai usage limit is close, or (null) no longer is — account-wide */
    onUsageWarning: (callback: (warning: UsageWarning | null) => void) => () => void;
    /** SDK session ID received for a conversation (for resume support) */
    onSessionId: (callback: (conversationId: string, sessionId: string) => void) => () => void;
    /** A discussion's Claude Code session turned out gone: seen deleted, or found so on resuming */
    onSessionGone: (callback: (conversationId: string) => void) => () => void;
    /** Whether a Claude Code session's transcript is still on disk */
    sessionExists: (sessionId: string) => Promise<boolean>;
    /** How long Claude Code keeps sessions (`cleanupPeriodDays` in its user settings) */
    getSessionRetention: () => Promise<SessionRetention>;
    /** Set how long Claude Code keeps sessions, in days */
    setSessionRetention: (days: number) => Promise<SessionRetention>;
    /** Get session permissions for a conversation */
    getSessionPermissions: (conversationId: string) => Promise<SessionPermissionEntry[]>;
    /** Revoke a session permission */
    revokeSessionPermission: (conversationId: string, permissionId: string) => Promise<boolean>;
    /** Clear all session permissions for a conversation */
    clearSessionPermissions: (conversationId: string) => Promise<void>;
    /** Seed the main-process cache from persisted per-conversation permissions on load */
    seedSessionPermissions: (conversationId: string, entries: SessionPermissionEntry[]) => Promise<void>;
    /** Listen for a discussion's session schedules, as each of its turns ends */
    onSessionSchedules: (callback: (conversationId: string, schedules: SessionSchedule[]) => void) => () => void;
    /** Listen for session permission changes */
    onSessionPermissionsChanged: (callback: (conversationId: string, permissions: SessionPermissionEntry[]) => void) => () => void;
    /** Allow rules and directories from the project's settings files */
    getProjectPermissions: (workingDirectory: string) => Promise<ProjectPermissionEntry[]>;
    /** Remove an entry from `.claude/settings.local.json`; resolves to the updated list */
    revokeProjectPermission: (
      workingDirectory: string,
      kind: ProjectPermissionEntry['kind'],
      value: string,
    ) => Promise<ProjectPermissionEntry[]>;
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
    /** What has changed in one file of the working directory. */
    fileChanges: (workingDir: string, filePath: string) => Promise<FileChanges>;
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
     * Pull from remote, asking for a login if it needs one. If
     * `expectedBranch` is supplied, the main process verifies HEAD matches
     * first. A failure is a result, saying when it was the login's.
     */
    pull: (workingDir: string, expectedBranch?: string) => Promise<GitRemoteResult>;
    /** Push to remote; as `pull`. */
    push: (workingDir: string, expectedBranch?: string) => Promise<GitRemoteResult>;
    /** Git needs a login for a push or pull: answer with `respondToCredentialRequest`. */
    onCredentialRequest: (callback: (request: GitCredentialRequest) => void) => () => void;
    /** The login for a credential request, or null to cancel it. */
    respondToCredentialRequest: (requestId: string, answer: GitCredentialAnswer | null) => Promise<void>;
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
    /**
     * The entries of `directory`, one level deep, which must be the working
     * directory or inside it. Directories come back without their entries.
     */
    listDirectory: (directory: string, workingDirectory: string) => Promise<FileNode[]>;
    read: (filePath: string) => Promise<string>;
    /**
     * Read an image a message points at — an absolute path, a `file:` URL,
     * or a path relative to `baseDir`. Null when there is no image there to
     * draw.
     */
    readImage: (
      reference: string,
      baseDir: string | null,
    ) => Promise<{ base64: string; mediaType: ImageMediaType } | null>;
    open: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    /** Show a file or folder of the working directory selected in the system's file manager. */
    showInFolder: (path: string) => Promise<{ success: boolean; error?: string }>;
    onChange: (callback: (changes: FileChange[]) => void) => () => void;
  };

  // MCP server management for the active project
  mcp: {
    /** Servers declared in `<project>/.mcp.json`, with approval state. */
    list: (workingDirectory: string) => Promise<McpServerEntry[]>;
    /**
     * Create or update a server. Pass `previousName` when editing (null to
     * create); a differing name renames the entry and moves its approval.
     * Resolves with the refreshed list.
     */
    save: (
      workingDirectory: string,
      previousName: string | null,
      server: McpServerInput
    ) => Promise<McpServerEntry[]>;
    /** Delete a server and drop its approval. Resolves with the new list. */
    remove: (workingDirectory: string, name: string) => Promise<McpServerEntry[]>;
    /** Turn a server on or off without deleting it. Resolves with the new list. */
    setEnabled: (
      workingDirectory: string,
      name: string,
      enabled: boolean
    ) => Promise<McpServerEntry[]>;
    /** Whether a stdio command can be launched from the packaged app. */
    checkCommand: (command: string) => Promise<McpCommandCheck>;
    /** Bundled Node path and platform. */
    getRuntimeInfo: () => Promise<McpRuntimeInfo>;
    /** Native picker for a server executable. Null when cancelled. */
    pickExecutable: () => Promise<string | null>;
    /** Native picker for a credentials or data file. Null when cancelled. */
    pickFile: () => Promise<string | null>;
    /**
     * The tools every project has (claude.ai connectors, user-wide servers)
     * and how each stands; open conversations are brought up to date with
     * connectors authorised since.
     */
    globalTools: () => Promise<GlobalTools>;
    /** Turn one of them off everywhere, or back on. Resolves with them as they now stand. */
    setOffEverywhere: (name: string, off: boolean) => Promise<GlobalTools>;
    /** Create or update a user-wide server. Pass null as `previousName` to create. */
    saveUserServer: (previousName: string | null, server: McpServerInput) => Promise<McpServerEntry[]>;
    /** Remove a user-wide server. */
    removeUserServer: (name: string) => Promise<McpServerEntry[]>;
    /** The tools every project has, as this project has them. */
    projectTools: (workingDirectory: string) => Promise<ProjectTools>;
    /** Turn one of them on or off in this project. Resolves with the project's tools as they now stand. */
    setEnabledInProject: (workingDirectory: string, name: string, enabled: boolean) => Promise<ProjectTools>;
    /** Open, in the browser, the claude.ai page that authorises a connector. */
    authorizeConnector: (name: string) => Promise<void>;
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
    /** The logged-in account, or null when it could not be read. */
    getAccount: () => Promise<ClaudeAccount | null>;
    startOAuth: () => Promise<{ authUrl: string; error?: string }>;
    completeOAuth: (code: string) => Promise<{ success: boolean; error?: string }>;
    /** Abandon a login in progress, ending the CLI process waiting for its code. */
    cancelOAuth: () => Promise<void>;
    logout: () => Promise<void>;
    onInvalidated: (callback: () => void) => () => void;
  };

  // Conversation operations
  conversation: {
    /** A page of the discussions list; see ConversationListRequest. */
    listPage: (request: ConversationListRequest) => Promise<ConversationListPage>;
    /** How many discussions are archived, by hand or for being inactive. */
    archivedCount: (autoArchiveDays: AutoArchiveDays) => Promise<number>;
    /** One discussion's list entry, or null when there is no such discussion. */
    summary: (id: string) => Promise<ConversationSummary | null>;
    /** Archive a discussion, or bring it back; returns its entry as it now stands. */
    setArchived: (id: string, archived: boolean) => Promise<ConversationSummary>;
    /** Save what is to happen about the usage limit that stopped its last turn, or null for nothing. */
    setUsageLimitWait: (id: string, wait: UsageLimitWait | null) => Promise<void>;
    /** The usage-limit waits saved, taken up at launch; see ConversationService.restoreUsageLimitWaits. */
    restoreUsageLimitWaits: () => Promise<RestoredUsageLimitWaits>;
    /**
     * Apply a change — add or replace messages by id, and metadata. The only
     * write: it cannot shorten a stored conversation except where it says so.
     */
    update: (update: ConversationUpdate) => Promise<void>;
    /** A conversation's last `limit` messages, plus how many are older. */
    getWindow: (id: string, limit: number) => Promise<ConversationWindow | null>;
    /** The `limit` messages stored immediately before `beforeId`. */
    getOlder: (
      id: string,
      beforeId: string,
      limit: number,
    ) => Promise<{ messages: ChatMessage[]; olderCount: number } | null>;
    /**
     * Store image bytes against a conversation, returning the reference a
     * message should carry. Null when the image is not one we accept — an
     * unsupported media type, or over the size limit.
     */
    saveImage: (
      conversationId: string,
      input: { base64: string; mediaType: string; label?: string },
    ) => Promise<MessageImage | null>;
    /** Read stored image bytes back. Null when there are none. */
    readImage: (
      conversationId: string,
      id: string,
      mediaType: string,
    ) => Promise<{ base64: string; mediaType: ImageMediaType } | null>;
    /**
     * The `limit` messages stored immediately after `afterId`, stopping at
     * `untilId` — the first message of a turn held in memory apart from the
     * window, which must not come back as a stale stored copy.
     */
    getNewer: (
      id: string,
      afterId: string,
      limit: number,
      untilId?: string | null,
    ) => Promise<{ messages: ChatMessage[]; newerCount: number } | null>;
    /**
     * Up to `before` messages ahead of `messageId`, the message, and up to
     * `after` behind it, with how many are stored either side — stopping at
     * `untilId`, as `getNewer` does. Null when the conversation or the
     * message is not stored, or the message lies inside that held turn.
     */
    getAround: (
      id: string,
      messageId: string,
      before: number,
      after: number,
      untilId?: string | null,
    ) => Promise<{ messages: ChatMessage[]; olderCount: number; newerCount: number } | null>;
    /** The stored message holding a tool call, wherever it is in the conversation; null when none. */
    findToolCall: (id: string, toolUseBlockId: string) => Promise<ChatMessage | null>;
    rename: (id: string, newTitle: string) => Promise<void>;
    delete: (id: string) => Promise<void>;
    search: (
      query: string,
      scope: ConversationSearchScope,
      currentConversationId: string | null,
    ) => Promise<ConversationSearchResult[]>;
  };

  // Update operations
  update: {
    check: () => Promise<UpdateInfo | null>;
    download: () => Promise<void>;
    install: () => Promise<UpdateInstallResult>;
    onAvailable: (callback: (info: UpdateInfo) => void) => () => void;
    onProgress: (callback: (progress: UpdateProgress) => void) => () => void;
    onDownloaded: (callback: () => void) => () => void;
  };

  /** Local speech-to-text through the bundled whisper binary */
  speech: {
    /** Whether dictation is available in this build, and which models are cached */
    getAvailability: () => Promise<{ available: boolean; downloadedModels: WhisperModelId[] }>;
    /** Transcribe 16-bit PCM WAV audio to text */
    transcribe: (
      wav: ArrayBuffer,
      model: WhisperModelId,
      language: string,
    ) => Promise<{ text: string; durationMs: number }>;
    /** Progress while a model is being downloaded on first use */
    onModelProgress: (callback: (progress: ModelDownloadProgress) => void) => () => void;
  };

  /** Versions and environment facts for the About dialog */
  about: {
    getInfo: () => Promise<AboutInfo>;
  };

  // Window operations
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
    /** Register for the pre-close flush request; returns an unsubscribe. */
    onFlushBeforeClose: (callback: () => void) => () => void;
    /** Tell the main process the pre-close flush has finished. */
    flushComplete: () => void;
    /**
     * Whether a permission ask or a question waits on the user; while one
     * does, the window flashes in the taskbar when it is not focused.
     */
    setAttentionNeeded: (needed: boolean) => void;
  };

  /** Writing renderer warnings and errors to main.log. Fire and forget. */
  log: {
    write: (entry: RendererLogEntry) => void;
  };

  /**
   * System clipboard, written from the main process.
   *
   * Not `navigator.clipboard`: that write is subject to Chromium's permission
   * and focus gates, and this window's permission handler denies everything
   * except media — so a refusal is indistinguishable from a control that does
   * nothing.
   */
  clipboard: {
    writeText: (text: string) => Promise<void>;
  };

  // Platform info
  platform: string;
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
