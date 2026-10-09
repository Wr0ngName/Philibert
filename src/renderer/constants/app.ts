/**
 * Renderer process constants
 * Centralized configuration values for the Vue frontend
 *
 * NOTE: Shared constants (FILE_CONSTANTS, CONVERSATION_CONSTANTS, PREVIEW_SIZES)
 * are imported from src/shared/constants.ts to avoid duplication.
 */
import { FILE_CONSTANTS, CONVERSATION_CONSTANTS, PREVIEW_SIZES } from '../../shared/constants';

// Re-export shared constants for convenience
export { FILE_CONSTANTS, CONVERSATION_CONSTANTS, PREVIEW_SIZES };

export const CONSTANTS = {
  /** Auto-save configuration */
  AUTO_SAVE: {
    /** Delay before auto-saving changes - 2 seconds */
    DELAY_MS: 2000,
  },
  /** Conversation-related limits (from shared constants) */
  CONVERSATION: {
    /** Maximum length for conversation titles */
    TITLE_MAX_LENGTH: CONVERSATION_CONSTANTS.TITLE_MAX_LENGTH,
    /** Length at which to truncate titles with ellipsis */
    TITLE_TRUNCATE_LENGTH: CONVERSATION_CONSTANTS.TITLE_TRUNCATE_LENGTH,
    /** Timeout for save operations - 30 seconds */
    SAVE_TIMEOUT_MS: 30000,
  },
  /** File system constants (from shared constants) */
  FILES: {
    /** Threshold for batch file changes before full tree reload */
    BATCH_CHANGE_THRESHOLD: FILE_CONSTANTS.BATCH_CHANGE_THRESHOLD,
  },
  /** UI configuration */
  UI: {
    /** Maximum height for auto-resizing textarea (pixels) */
    TEXTAREA_MAX_HEIGHT: 200,
    /** Debounce delay for file watcher events (ms) */
    FILE_WATCHER_DEBOUNCE_MS: 300,
    /** Scroll margin for auto-scrolling (pixels) */
    SCROLL_MARGIN: 100,
  },
  /** Time unit constants */
  TIME: {
    MILLISECONDS_PER_SECOND: 1000,
    SECONDS_PER_MINUTE: 60,
    MINUTES_PER_HOUR: 60,
    HOURS_PER_DAY: 24,
    DAYS_PER_WEEK: 7,
  },
  /** Vue transition class configurations */
  TRANSITIONS: {
    /** Standard fade transition for modals and overlays */
    FADE: {
      enter: 'transition ease-out duration-200',
      enterFrom: 'opacity-0',
      enterTo: 'opacity-100',
      leave: 'transition ease-in duration-150',
      leaveFrom: 'opacity-100',
      leaveTo: 'opacity-0',
    },
    /** Slide-up transition for panels and toasts */
    SLIDE_UP: {
      enter: 'transition-all duration-200 ease-out',
      enterFrom: 'opacity-0 translate-y-2',
      enterTo: 'opacity-100 translate-y-0',
      leave: 'transition-all duration-150 ease-in',
      leaveFrom: 'opacity-100 translate-y-0',
      leaveTo: 'opacity-0 translate-y-2',
    },
    /** Slide-down transition for notifications and error banners */
    SLIDE_DOWN: {
      enter: 'transition-all duration-200 ease-out',
      enterFrom: 'opacity-0 -translate-y-2',
      enterTo: 'opacity-100 translate-y-0',
      leave: 'transition-all duration-150 ease-in',
      leaveFrom: 'opacity-100 translate-y-0',
      leaveTo: 'opacity-0 -translate-y-2',
    },
    /** Scale transition for modal content */
    SCALE: {
      enter: 'transition ease-out duration-200',
      enterFrom: 'opacity-0 scale-95',
      enterTo: 'opacity-100 scale-100',
      leave: 'transition ease-in duration-150',
      leaveFrom: 'opacity-100 scale-100',
      leaveTo: 'opacity-0 scale-95',
    },
    /** Collapse transition for expandable sections */
    COLLAPSE: {
      enter: 'transition-all duration-150 ease-out',
      enterFrom: 'opacity-0 max-h-0',
      enterTo: 'opacity-100 max-h-screen',
      leave: 'transition-all duration-100 ease-in',
      leaveFrom: 'opacity-100 max-h-screen',
      leaveTo: 'opacity-0 max-h-0',
    },
  },
} as const;

// Computed time constants for convenience
export const TIME_MS = {
  ONE_SECOND: CONSTANTS.TIME.MILLISECONDS_PER_SECOND,
  ONE_MINUTE: CONSTANTS.TIME.SECONDS_PER_MINUTE * CONSTANTS.TIME.MILLISECONDS_PER_SECOND,
  ONE_HOUR: CONSTANTS.TIME.MINUTES_PER_HOUR * CONSTANTS.TIME.SECONDS_PER_MINUTE * CONSTANTS.TIME.MILLISECONDS_PER_SECOND,
  ONE_DAY: CONSTANTS.TIME.HOURS_PER_DAY * CONSTANTS.TIME.MINUTES_PER_HOUR * CONSTANTS.TIME.SECONDS_PER_MINUTE * CONSTANTS.TIME.MILLISECONDS_PER_SECOND,
  ONE_WEEK: CONSTANTS.TIME.DAYS_PER_WEEK * CONSTANTS.TIME.HOURS_PER_DAY * CONSTANTS.TIME.MINUTES_PER_HOUR * CONSTANTS.TIME.SECONDS_PER_MINUTE * CONSTANTS.TIME.MILLISECONDS_PER_SECOND,
} as const;
