/**
 * Shared types used across main, preload, and renderer processes
 */

/**
 * Role of a message in the chat conversation
 * - user: Message from the user
 * - assistant: Message from Claude AI
 * - system: System notification or instruction
 */
export type MessageRole = 'user' | 'assistant' | 'system';

/**
 * Information about a slash command from the Claude SDK
 */
export interface SlashCommandInfo {
  /** Command name (without leading slash) */
  name: string;
  /** Description of what the command does */
  description: string;
  /** Hint for command arguments */
  argumentHint: string;
}

/**
 * Information about an available Claude model from the SDK
 */
export interface ModelInfo {
  /** Model identifier to use in API calls */
  value: string;
  /** Human-readable display name */
  displayName: string;
  /** Description of the model's capabilities */
  description?: string;
}

/**
 * Inline tool use indicator shown in the message stream.
 * Links to a PendingAction for approval status tracking.
 */
export interface ToolUseInfo {
  /** The action ID (links to PendingAction) */
  actionId: string;
  /** Tool name (e.g., 'Bash', 'Read', 'Write', 'Edit') */
  toolName: string;
  /** Short description (e.g., "Read file: /path/to/file.ts") */
  description: string;
  /** Current status */
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
  /** SDK tool_use block ID (toolu_xxx) — correlates with tool_result */
  toolUseBlockId?: string;
  /** Raw input parameters from the tool_use block */
  input?: Record<string, unknown>;
  /** Path to temp file containing tool output (lazy-loaded on click) */
  outputFile?: string;
}

/** Data emitted for every tool_use block in assistant messages */
export interface ToolCaptureData {
  toolUseBlockId: string;
  toolName: string;
  input: Record<string, unknown>;
  description: string;
}

/** Data emitted when a tool result is captured and written to disk */
export interface ToolResultData {
  toolUseBlockId: string;
  outputFile: string;
}

/**
 * Inline background task indicator shown in the message stream.
 * Links to a BackgroundTask in the store for status tracking.
 */
export interface BackgroundTaskInfo {
  /** The task ID (links to BackgroundTask in store) */
  taskId: string;
  /** Short description of the task */
  description: string;
  /** Current status */
  status: BackgroundTaskStatus;
  /** Summary text when completed */
  summary?: string;
  /** Error message when failed */
  error?: string;
}

/**
 * Represents a single message in the chat conversation
 */
export interface ChatMessage {
  /** Unique identifier for the message */
  id: string;
  /** Role of the message sender */
  role: MessageRole;
  /** Text content of the message */
  content: string;
  /** Unix timestamp when the message was created */
  timestamp: number;
  /** Whether the message is currently being streamed */
  isStreaming?: boolean;
  /** If set, this message represents an inline tool use indicator */
  toolUse?: ToolUseInfo;
  /** If set, this message represents an inline background task indicator */
  backgroundTask?: BackgroundTaskInfo;
}

// Tool use / Action types

/**
 * Type of action that can be performed by Claude
 * - file-edit: Modify an existing file
 * - file-create: Create a new file
 * - file-delete: Delete an existing file
 * - bash-command: Execute a bash command
 * - read-file: Read the contents of a file
 */
export type ActionType = 'file-edit' | 'file-create' | 'file-delete' | 'bash-command' | 'read-file';

/**
 * Current status of an action in its lifecycle
 * - pending: Waiting for user approval
 * - approved: User has approved the action
 * - rejected: User has rejected the action
 * - executed: Action has been successfully executed
 * - failed: Action execution failed
 */
export type ActionStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';

/**
 * Details for editing an existing file
 */
export interface FileEditDetails {
  /** Path to the file to edit */
  filePath: string;
  /** Original content of the file before editing */
  originalContent?: string;
  /** New content to write to the file */
  newContent: string;
  /** Visual diff of the changes */
  diff?: string;
}

/**
 * Details for creating a new file
 */
export interface FileCreateDetails {
  /** Path where the new file will be created */
  filePath: string;
  /** Content to write to the new file */
  content: string;
}

/**
 * Details for deleting a file
 */
export interface FileDeleteDetails {
  /** Path to the file to delete */
  filePath: string;
}

/**
 * Details for executing a bash command
 */
export interface BashCommandDetails {
  /** The bash command to execute */
  command: string;
  /** Directory where the command should be executed */
  workingDirectory: string;
}

/**
 * Details for reading a file
 */
export interface ReadFileDetails {
  /** Path to the file to read */
  filePath: string;
}

/**
 * Union type of all possible action details
 */
export type ActionDetails = FileEditDetails | FileCreateDetails | FileDeleteDetails | BashCommandDetails | ReadFileDetails;

/**
 * The scope at which a permission rule applies
 * - session: Only for the current session (temporary)
 * - project: For this project directory (stored in project settings)
 * - global: For all projects (stored in user settings)
 */
export type PermissionScope = 'session' | 'project' | 'global';

/**
 * A single scope option presented to the user in the permission approval UI.
 * Each option maps to a set of SDK PermissionUpdate suggestions for that scope.
 */
export interface PermissionScopeOption {
  /** The scope this option applies to */
  scope: PermissionScope;
  /** Button label (e.g. "Allow Bash this session") */
  label: string;
  /** Tooltip description of what will be allowed */
  description: string;
}

/**
 * Human-readable info about what the "always allow" action will do.
 * Generated from SDK PermissionUpdate suggestions.
 */
export interface PermissionSuggestionInfo {
  /** Human-readable label for the broadest-scope button (legacy, used as fallback) */
  alwaysAllowLabel: string;
  /** Detailed description of what will be allowed (shown as tooltip) */
  description: string;
  /** The broadest scope across all suggestions (legacy, used as fallback) */
  scope: PermissionScope;
  /** Per-scope options for the UI. Each entry becomes a separate button. */
  scopeOptions: PermissionScopeOption[];
}

/**
 * A cached session permission entry.
 * Represents a permission granted via "Always Allow" with session scope.
 */
export interface SessionPermissionEntry {
  /** Unique identifier for this cached permission */
  id: string;
  /** The tool name this permission applies to (e.g., 'Bash', 'Write') */
  toolName: string;
  /** Optional rule content from the SDK */
  ruleContent?: string;
  /** Human-readable description of the permission */
  description: string;
  /** When this permission was granted */
  grantedAt: number;
}

/**
 * Context about WHY a permission was requested (from SDK CanUseTool options).
 * Helps the user understand what triggered the permission prompt.
 */
export interface PermissionContext {
  /** The specific path that was blocked (e.g., "/etc/passwd") */
  blockedPath?: string;
  /** Human-readable reason from the SDK (e.g., "Bash command tries to access path outside allowed directories") */
  decisionReason?: string;
}

/**
 * Base interface for all action types
 */
interface BaseAction {
  /** Unique identifier for the action */
  id: string;
  /** Name of the tool used for this action */
  toolName: string;
  /** Human-readable description of the action */
  description: string;
  /** Raw input parameters for the action */
  input: Record<string, unknown>;
  /** Current status of the action */
  status: ActionStatus;
  /** Unix timestamp when the action was created */
  timestamp: number;
  /** Info about what "always allow" will do (from SDK suggestions) */
  permissionInfo?: PermissionSuggestionInfo;
  /** Context about why this permission was requested */
  permissionContext?: PermissionContext;
}

/**
 * Action for editing an existing file
 */
export interface FileEditAction extends BaseAction {
  type: 'file-edit';
  details: FileEditDetails;
}

/**
 * Action for creating a new file
 */
export interface FileCreateAction extends BaseAction {
  type: 'file-create';
  details: FileCreateDetails;
}

/**
 * Action for deleting a file
 */
export interface FileDeleteAction extends BaseAction {
  type: 'file-delete';
  details: FileDeleteDetails;
}

/**
 * Action for executing a bash command
 */
export interface BashCommandAction extends BaseAction {
  type: 'bash-command';
  details: BashCommandDetails;
}

/**
 * Action for reading a file
 */
export interface ReadFileAction extends BaseAction {
  type: 'read-file';
  details: ReadFileDetails;
}

/**
 * Discriminated union of all possible pending actions
 * Allows type-safe narrowing based on the 'type' field
 */
export type PendingAction = FileEditAction | FileCreateAction | FileDeleteAction | BashCommandAction | ReadFileAction;

/**
 * Response from renderer for action approval
 */
export interface ActionResponse {
  /** Conversation ID this action belongs to */
  conversationId: string;
  /** ID of the action being responded to */
  actionId: string;
  /** Whether the user approved the action */
  approved: boolean;
  /** Modified input parameters if user edited them */
  updatedInput?: Record<string, unknown>;
  /** Whether to automatically approve similar actions in the future */
  alwaysAllow?: boolean;
  /** Which permission scope the user chose (session/project/global).
   *  When set, only suggestions matching this scope are applied. */
  chosenScope?: PermissionScope;
  /** Optional message explaining why the action was denied */
  denyMessage?: string;
}

// File system types

/**
 * Type of file system node
 * - file: Regular file
 * - directory: Directory/folder
 */
export type FileNodeType = 'file' | 'directory';

/**
 * Represents a node in the file system tree
 */
export interface FileNode {
  /** Name of the file or directory */
  name: string;
  /** Full path to the file or directory */
  path: string;
  /** Type of the node */
  type: FileNodeType;
  /** Child nodes if this is a directory */
  children?: FileNode[];
  /** Size of the file in bytes (only for files) */
  size?: number;
  /** Unix timestamp of last modification */
  modifiedAt?: number;
}

// Authentication types

/**
 * Method used for authenticating with Claude API
 * - oauth: OAuth token from claude CLI
 * - api-key: Direct API key
 * - none: No authentication configured
 */
export type AuthMethod = 'oauth' | 'api-key' | 'none';

/**
 * Current authentication status
 */
export interface AuthStatus {
  /** Whether the user is currently authenticated */
  isAuthenticated: boolean;
  /** Authentication method being used */
  method: AuthMethod;
  /** Display name for the authenticated account (OAuth only) */
  displayName?: string;
}

// Configuration types

/**
 * Theme mode for the application UI
 * - light: Light theme
 * - dark: Dark theme
 * - system: Follow system preference
 */
export type ThemeMode = 'light' | 'dark' | 'system';

/**
 * Log level for application logging
 * - error: Only errors
 * - warn: Warnings and errors
 * - info: Info, warnings, and errors
 * - debug: All log messages including debug
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * Update channel for auto-updates
 * - stable: Only stable releases (e.g., v1.0.0)
 * - rc: Include release candidates (e.g., v1.0.0-rc.1)
 */
export type UpdateChannel = 'stable' | 'rc';

/**
 * Execution mode for Claude integration.
 * - sdk: Claude Agent SDK — billed against a separate capped credit pool
 * - channel: Claude Code in PTY with MCP channel — billed against subscription (Pro/Max)
 */
export type ExecutionMode = 'sdk' | 'channel';

export type ThinkingMode = 'auto' | 'disabled';

/**
 * Application configuration settings
 */
export interface AppConfig {
  /** Direct API key for Claude API */
  apiKey: string;
  /** OAuth token from claude CLI setup-token */
  oauthToken: string;
  /** Authentication method being used */
  authMethod: AuthMethod;
  /** Current working directory for file operations */
  workingDirectory: string;
  /** List of recently opened project paths */
  recentProjects: string[];
  /** UI theme mode */
  theme: ThemeMode;
  /** Font size for the chat interface */
  fontSize: number;
  /** Line height for the chat interface (unitless multiplier) */
  lineHeight: number;
  /** Whether to automatically approve read-file actions */
  autoApproveReads: boolean;
  /** Log level for application logging */
  logLevel: LogLevel;
  /** Selected Claude model (empty means SDK default) */
  selectedModel: string;
  /** Whether the user has completed the initial setup wizard */
  hasCompletedInitialSetup: boolean;
  /** Whether to show the conversation history sidebar */
  showHistorySidebar: boolean;
  /** Whether to show the file browser sidebar */
  showFilesSidebar: boolean;
  /** Whether to show native OS notifications when window is not focused */
  enableNotifications: boolean;
  /** ID of the last active conversation (for auto-restore on startup) */
  lastConversationId: string;
  /** Auto-update channel: 'stable' for releases only, 'rc' to include release candidates */
  updateChannel: UpdateChannel;
  /** Execution mode: 'sdk' for Agent SDK (credit pool), 'channel' for PTY/MCP (subscription) */
  executionMode: ExecutionMode;
  /** Extended thinking mode: 'auto' lets Claude decide, 'disabled' saves tokens */
  thinkingMode: ThinkingMode;
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: AppConfig = {
  apiKey: '',
  oauthToken: '',
  authMethod: 'none',
  workingDirectory: '',
  recentProjects: [],
  theme: 'system',
  fontSize: 14,
  lineHeight: 1.6,
  autoApproveReads: true,
  logLevel: 'warn',
  selectedModel: '', // Empty means use SDK default
  hasCompletedInitialSetup: false,
  showHistorySidebar: true,
  showFilesSidebar: true,
  enableNotifications: true,
  lastConversationId: '',
  updateChannel: 'stable',
  executionMode: 'sdk',
  thinkingMode: 'auto',
};

// Conversation types

/**
 * Represents a saved conversation with Claude
 */
export interface Conversation {
  /** Unique identifier for the conversation */
  id: string;
  /** User-facing title of the conversation */
  title: string;
  /** Whether the title was manually set by the user (vs auto-generated) */
  customTitle?: boolean;
  /** Working directory context for this conversation */
  workingDirectory: string;
  /** All messages in the conversation */
  messages: ChatMessage[];
  /** Unix timestamp when the conversation was created */
  createdAt: number;
  /** Unix timestamp when the conversation was last updated */
  updatedAt: number;
  /** SDK session ID for resuming conversation context */
  sdkSessionId?: string;
}

// Git types

/**
 * Git repository status information
 */
export interface GitStatus {
  /** Whether the working directory is a git repository */
  isGitRepo: boolean;
  /** Current branch name */
  branch: string;
  /** Count of uncommitted changes (staged + unstaged + untracked) */
  dirty: number;
  /** Commits ahead of remote tracking branch */
  ahead: number;
  /** Commits behind remote tracking branch */
  behind: number;
}

// Update types

// Background Task types

/**
 * Status of a background task
 * - running: Task is currently executing
 * - completed: Task finished successfully
 * - failed: Task execution failed
 * - stopped: Task was manually stopped/aborted
 */
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

/**
 * Represents a background task (subagent or background command)
 */
export interface BackgroundTask {
  /** Unique identifier for the task */
  id: string;
  /** Short description of the task */
  description: string;
  /** Current status of the task */
  status: BackgroundTaskStatus;
  /** Unix timestamp when the task started */
  startedAt: number;
  /** Unix timestamp when the task completed (if finished) */
  completedAt?: number;
  /** Summary of the task result (if completed) */
  summary?: string;
  /** Output file path (if applicable) */
  outputFile?: string;
  /** Session ID the task belongs to */
  sessionId?: string;
  /** Error message if task failed */
  error?: string;
}

/**
 * Notification from the SDK about a background task status change
 */
export interface TaskNotification {
  /** Task identifier */
  taskId: string;
  /** New status of the task */
  status: BackgroundTaskStatus;
  /** Task description */
  description?: string;
  /** Summary of the result */
  summary?: string;
  /** Output file path */
  outputFile?: string;
  /** Session ID */
  sessionId?: string;
  /** Error message if failed */
  error?: string;
  /** UUID of the task */
  uuid?: string;
  /** Previous task ID when remapping (e.g., tool_use ID → background task ID) */
  previousTaskId?: string;
}

// Channel mode types

/**
 * Status of the channel execution mode
 */
export interface ChannelStatus {
  mode: ExecutionMode;
  bridgeHealthy: boolean;
  sessionRunning: boolean;
}

/**
 * Per-model token counts and cost for channel mode usage tracking
 */
export interface ChannelModelTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

/**
 * Aggregated usage data from Claude Code's session JSONL files.
 * Used in channel mode to provide token/cost visibility despite
 * subscription billing.
 */
export interface ChannelUsageData {
  models: Record<string, ChannelModelTokens>;
  totals: ChannelModelTokens;
}

// Context/Usage types

/**
 * Token usage information from the SDK
 */
export interface TokenUsage {
  /** Input tokens used */
  inputTokens: number;
  /** Output tokens generated */
  outputTokens: number;
  /** Tokens read from cache */
  cacheReadInputTokens: number;
  /** Tokens written to cache */
  cacheCreationInputTokens: number;
}

/**
 * Per-model usage breakdown
 */
export interface ModelUsageInfo {
  /** Input tokens used */
  inputTokens: number;
  /** Output tokens generated */
  outputTokens: number;
  /** Tokens read from cache */
  cacheReadInputTokens: number;
  /** Tokens written to cache */
  cacheCreationInputTokens: number;
  /** Number of web search requests */
  webSearchRequests: number;
  /** Cost in USD */
  costUSD: number;
  /** Context window size for this model */
  contextWindow: number;
  /** Maximum output tokens for this model */
  maxOutputTokens: number;
}

/**
 * Session usage information sent to the renderer
 */
export interface SessionUsage {
  /** Total cost in USD for this session */
  totalCostUSD: number;
  /** Aggregated token usage */
  usage: TokenUsage;
  /** Per-model usage breakdown */
  modelUsage: Record<string, ModelUsageInfo>;
  /** Number of turns in the conversation */
  numTurns: number;
  /** Duration of the query in milliseconds */
  durationMs: number;
  /** Current context window occupation in tokens (from SDK getContextUsage) */
  contextTokens?: number;
  /** Context window maximum in tokens (from SDK getContextUsage) */
  contextMaxTokens?: number;
}

// Update types

/**
 * Information about an available application update
 */
export interface UpdateInfo {
  /** Version number of the update */
  version: string;
  /** Release notes for the update */
  releaseNotes?: string;
  /** Date the update was released */
  releaseDate?: string;
}

/**
 * Progress information for downloading an update
 */
export interface UpdateProgress {
  /** Download progress as a percentage (0-100) */
  percent: number;
  /** Current download speed in bytes per second */
  bytesPerSecond: number;
  /** Total size of the download in bytes */
  total: number;
  /** Number of bytes transferred so far */
  transferred: number;
}

// IPC Event types

/**
 * Maximum number of concurrent SDK queries allowed
 * Each query spawns a Node.js child process (~50-100MB RAM)
 */
export const MAX_CONCURRENT_QUERIES = 5;

/**
 * Map of IPC event names to their handler signatures
 * These events are sent from main process to renderer process
 * All Claude events include conversationId for multi-conversation support
 */
export type IpcMainEvents = {
  /** Streaming chunk of text from Claude */
  'claude:chunk': (conversationId: string, chunk: string) => void;
  /** Claude is requesting approval for a tool use action */
  'claude:tool-use': (conversationId: string, action: PendingAction) => void;
  /** An error occurred during Claude interaction */
  'claude:error': (conversationId: string, error: string) => void;
  /** Claude has finished processing the current request */
  'claude:done': (conversationId: string) => void;
  /** File system changes detected */
  'files:changed': (changes: FileChange[]) => void;
  /** Application configuration has changed */
  'config:changed': (config: Partial<AppConfig>) => void;
  /** A new application update is available */
  'update:available': (info: UpdateInfo) => void;
  /** Update download progress */
  'update:progress': (progress: UpdateProgress) => void;
  /** Update has been downloaded and is ready to install */
  'update:downloaded': () => void;
  /** Background task notification from Claude */
  'claude:task-notification': (conversationId: string, notification: TaskNotification) => void;
  /** Session usage update (tokens, cost) */
  'claude:usage-update': (conversationId: string, usage: SessionUsage) => void;
  /** Slash commands available from SDK */
  'claude:slash-commands': (conversationId: string, commands: SlashCommandInfo[]) => void;
  /** Active query count changed */
  'claude:active-queries': (count: number, maxCount: number) => void;
  /** Git status changed (event-driven from file watchers) */
  'git:status-changed': (status: GitStatus) => void;
  /** Stored credentials were invalidated (e.g. 401 from API) — UI should prompt re-login */
  'auth:invalidated': () => void;
};

/**
 * Represents a detected change to a file
 */
export interface FileChange {
  /** Type of change that occurred */
  type: 'add' | 'change' | 'unlink';
  /** Path to the file that changed */
  path: string;
}

/**
 * IPC channel names used for communication between main and renderer processes
 * Using 'as const' ensures type safety and prevents modification
 */
export const IPC_CHANNELS = {
  // Claude operations
  /** Send a message to Claude */
  CLAUDE_SEND: 'claude:send',
  /** Receive streaming chunk from Claude */
  CLAUDE_CHUNK: 'claude:chunk',
  /** Claude is requesting tool use approval */
  CLAUDE_TOOL_USE: 'claude:tool-use',
  /** Approve a pending action */
  CLAUDE_APPROVE: 'claude:approve',
  /** Reject a pending action */
  CLAUDE_REJECT: 'claude:reject',
  /** Error occurred during Claude interaction */
  CLAUDE_ERROR: 'claude:error',
  /** Claude finished processing */
  CLAUDE_DONE: 'claude:done',
  /** Abort current Claude request */
  CLAUDE_ABORT: 'claude:abort',
  /** Send action approval/rejection response */
  CLAUDE_ACTION_RESPONSE: 'claude:action-response',
  /** Available slash commands from SDK */
  CLAUDE_SLASH_COMMANDS: 'claude:slash-commands',
  /** Get available slash commands */
  CLAUDE_GET_COMMANDS: 'claude:get-commands',
  /** Built-in command action (clear, compact, etc.) */
  CLAUDE_COMMAND_ACTION: 'claude:command-action',
  /** Get available models from SDK */
  CLAUDE_GET_MODELS: 'claude:get-models',
  /** Model changed event */
  CLAUDE_MODEL_CHANGED: 'claude:model-changed',
  /** Background task notification */
  CLAUDE_TASK_NOTIFICATION: 'claude:task-notification',
  /** Session usage update (token counts, cost) */
  CLAUDE_USAGE_UPDATE: 'claude:usage-update',
  /** Active query count changed */
  CLAUDE_ACTIVE_QUERIES: 'claude:active-queries',
  /** Get current active query status */
  CLAUDE_GET_ACTIVE_QUERIES: 'claude:get-active-queries',
  /** SDK session ID for conversation continuity */
  CLAUDE_SESSION_ID: 'claude:session-id',
  /** Get session permissions for a conversation */
  CLAUDE_GET_SESSION_PERMISSIONS: 'claude:get-session-permissions',
  /** Revoke a session permission */
  CLAUDE_REVOKE_SESSION_PERMISSION: 'claude:revoke-session-permission',
  /** Clear all session permissions for a conversation */
  CLAUDE_CLEAR_SESSION_PERMISSIONS: 'claude:clear-session-permissions',
  /** Session permissions changed event */
  CLAUDE_SESSION_PERMISSIONS_CHANGED: 'claude:session-permissions-changed',
  /** System status note (compaction, model change, etc.) — rendered as a separator, not inline text */
  CLAUDE_SYSTEM_NOTE: 'claude:system-note',
  /** Tool use captured from assistant message (all tools, including auto-approved) */
  CLAUDE_TOOL_CAPTURE: 'claude:tool-capture',
  /** Tool result written to disk (output file path) */
  CLAUDE_TOOL_RESULT: 'claude:tool-result',
  /** Tool execution completed (action was approved and SDK proceeded) */
  CLAUDE_TOOL_EXECUTED: 'claude:tool-executed',
  /** Channel mode status update (bridge health, session running) */
  CLAUDE_CHANNEL_STATUS: 'claude:channel-status',

  // Git operations
  /** Get git repository status */
  GIT_STATUS: 'git:status',
  /** Commit all changes */
  GIT_COMMIT: 'git:commit',
  /** Pull from remote */
  GIT_PULL: 'git:pull',
  /** Push to remote */
  GIT_PUSH: 'git:push',
  /** Fetch from remote (background, updates tracking refs) */
  GIT_FETCH: 'git:fetch',
  /** Git status changed (event from main to renderer) */
  GIT_STATUS_CHANGED: 'git:status-changed',

  // File operations
  /** Open directory picker dialog */
  FILES_SELECT_DIR: 'files:select-directory',
  /** Get file system tree for a directory */
  FILES_GET_TREE: 'files:get-tree',
  /** Read contents of a file */
  FILES_READ: 'files:read',
  /** File system changes detected */
  FILES_CHANGED: 'files:changed',
  /** Open a file in the system's default application */
  FILES_OPEN: 'files:open',

  // Config operations
  /** Get current configuration */
  CONFIG_GET: 'config:get',
  /** Update configuration */
  CONFIG_SET: 'config:set',
  /** Configuration changed event */
  CONFIG_CHANGED: 'config:changed',

  // Conversation operations
  /** Get list of all conversations */
  CONVERSATION_LIST: 'conversation:list',
  /** Get a specific conversation */
  CONVERSATION_GET: 'conversation:get',
  /** Save a conversation */
  CONVERSATION_SAVE: 'conversation:save',
  /** Rename a conversation */
  CONVERSATION_RENAME: 'conversation:rename',
  /** Delete a conversation */
  CONVERSATION_DELETE: 'conversation:delete',

  // Update operations
  /** Check for application updates */
  UPDATE_CHECK: 'update:check',
  /** Download available update */
  UPDATE_DOWNLOAD: 'update:download',
  /** Install downloaded update */
  UPDATE_INSTALL: 'update:install',
  /** Update is available */
  UPDATE_AVAILABLE: 'update:available',
  /** Update download progress */
  UPDATE_PROGRESS: 'update:progress',
  /** Update download completed */
  UPDATE_DOWNLOADED: 'update:downloaded',

  // Authentication operations
  /** Get current authentication status */
  AUTH_GET_STATUS: 'auth:get-status',
  /** Start OAuth flow */
  AUTH_START_OAUTH: 'auth:start-oauth',
  /** Complete OAuth flow */
  AUTH_COMPLETE_OAUTH: 'auth:complete-oauth',
  /** Log out and clear credentials */
  AUTH_LOGOUT: 'auth:logout',
  /** Fired when stored credentials are invalidated (e.g. 401 from API) */
  AUTH_INVALIDATED: 'auth:invalidated',

  // Window operations
  /** Minimize application window */
  WINDOW_MINIMIZE: 'window:minimize',
  /** Maximize/restore application window */
  WINDOW_MAXIMIZE: 'window:maximize',
  /** Close application window */
  WINDOW_CLOSE: 'window:close',
} as const;

/**
 * Type-safe IPC channel name derived from IPC_CHANNELS constant
 */
export type IpcChannelName = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS];
