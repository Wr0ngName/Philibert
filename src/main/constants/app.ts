/**
 * Main process constants
 * Centralized magic numbers for configuration and timeouts
 *
 * NOTE: Shared constants (FILE_CONSTANTS, PREVIEW_SIZES) are in src/shared/constants.ts
 */
import { FILE_CONSTANTS, PREVIEW_SIZES } from '../../shared/constants';

// Re-export for convenience
export { FILE_CONSTANTS, PREVIEW_SIZES };

export const MAIN_CONSTANTS = {
  AUTH: {
    /** OAuth flow timeout - 10 minutes */
    OAUTH_TIMEOUT_MS: 600000,
    /** Time to wait for OAuth URL to appear in CLI output - 30 seconds */
    OAUTH_URL_DETECTION_TIMEOUT_MS: 30000,
    /** Delay before considering OAuth URL ready - 3 seconds */
    OAUTH_URL_DETECTION_DELAY_MS: 3000,
    /** OAuth completion timeout - 45 seconds (90 attempts * 500ms) */
    OAUTH_COMPLETION_TIMEOUT_MS: 45000,
    /** Polling interval for OAuth completion - 500ms */
    OAUTH_POLL_INTERVAL_MS: 500,
    /** Maximum polling attempts for OAuth completion */
    OAUTH_POLL_MAX_ATTEMPTS: 90,
    /** Delay after OAuth process exit before final check - 500ms */
    OAUTH_PROCESS_EXIT_DELAY_MS: 500,
    /** Delay before checking credentials file - 500ms */
    OAUTH_CREDENTIALS_CHECK_DELAY_MS: 500,
    /** Wide terminal width to prevent URL wrapping */
    OAUTH_TERMINAL_COLS: 500,
    /** Terminal rows for OAuth PTY */
    OAUTH_TERMINAL_ROWS: 30,
    /** Minimum length for OAuth authorization code */
    OAUTH_CODE_MIN_LENGTH: 10,
    /** Maximum length for OAuth authorization code */
    OAUTH_CODE_MAX_LENGTH: 500,
    /** Delay before cleaning up PTY resources - 1 second */
    PTY_CLEANUP_DELAY_MS: 1000,
    /** Minimum API key length for validation */
    API_KEY_MIN_LENGTH: 40,
    /**
     * Minimum length for an OAuth token. Real tokens from `claude setup-token`
     * are ~108 chars (sk-ant-oat01- + ~95 base64url chars). Below 40 is
     * always corruption (e.g. ANSI strip ate part of the body).
     */
    OAUTH_TOKEN_MIN_LENGTH: 40,
    /**
     * Hard cap on OAuth token length. Defends storage against pathological
     * extraction that captures the entire CLI output as the "token". Real
     * tokens never exceed ~300 chars.
     */
    OAUTH_TOKEN_MAX_LENGTH: 512,
    /**
     * Recognised OAuth token type prefixes. The full prefix `sk-ant-` is
     * followed by a type segment then `-` then the base64url body.
     * - `oat01-` : OAuth long-lived access token from `setup-token`
     * - `api03-` : API key (some users paste these into the OAuth flow)
     */
    KNOWN_TOKEN_TYPE_PREFIXES: ['sk-ant-oat01-', 'sk-ant-api03-'] as const,
  },
  CLAUDE: {
    /** Delay when interrupting Claude operations - 1 second */
    INTERRUPT_DELAY_MS: 1000,
  },
  FILES: {
    /** Debounce interval for file watcher events (from shared constants) */
    WATCHER_DEBOUNCE_MS: FILE_CONSTANTS.WATCHER_DEBOUNCE_MS,
    /** Maximum depth for file tree scanning */
    MAX_TREE_DEPTH: 5,
    /** Threshold for batch file changes before full tree reload (from shared constants) */
    BATCH_CHANGE_THRESHOLD: FILE_CONSTANTS.BATCH_CHANGE_THRESHOLD,
  },
  GIT: {
    /**
     * How often to run a background `git fetch --quiet` on the currently
     * watched directory to keep ahead/behind counts fresh against a remote
     * that other people are pushing to. Only runs while a watcher is
     * active — switching away from a git-repo directory tears it down.
     */
    REMOTE_FETCH_INTERVAL_MS: 60_000,
  },
  CONFIG: {
    /** Maximum number of recent projects to keep */
    MAX_RECENT_PROJECTS: 10,
  },
  CONVERSATION: {
    /** Base delay for retry exponential backoff - 100ms */
    RETRY_BASE_DELAY_MS: 100,
    /** Maximum number of save retries */
    MAX_SAVE_RETRIES: 3,
  },
  LOGGING: {
    /** Maximum log file size before rotation - 5MB */
    MAX_FILE_SIZE_BYTES: 5 * 1024 * 1024,
  },
  WINDOW: {
    /** Default window width */
    DEFAULT_WIDTH: 1400,
    /** Default window height */
    DEFAULT_HEIGHT: 900,
    /** Minimum window width */
    MIN_WIDTH: 800,
    /** Minimum window height */
    MIN_HEIGHT: 600,
    /** Timeout for showing window if ready-to-show doesn't fire - 5 seconds */
    SHOW_TIMEOUT_MS: 5000,
  },
  CHANNEL: {
    /** PTY terminal columns */
    PTY_COLS: 120,
    /** PTY terminal rows */
    PTY_ROWS: 40,
    /** Timeout for trust dialog auto-accept */
    TRUST_DIALOG_TIMEOUT_MS: 30000,
    /** Maximum restart attempts for crashed sessions */
    MAX_RESTART_ATTEMPTS: 10,
    /** Base delay for exponential backoff on restart (ms) */
    RESTART_BASE_DELAY_MS: 5000,
    /** Long-poll timeout for bridge HTTP endpoints (ms) */
    POLL_TIMEOUT_MS: 30000,
    /** TTL for unanswered permission requests before auto-deny (ms) */
    PERMISSION_TTL_MS: 600000,
    /** Interval for polling usage data from JSONL files (ms) */
    USAGE_POLL_INTERVAL_MS: 10000,
    /** Session health check interval (ms) */
    HEALTH_CHECK_INTERVAL_MS: 10000,
  },
} as const;
