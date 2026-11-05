/**
 * Shared constants used across main and renderer processes
 *
 * This file centralizes magic values and configuration constants
 * to eliminate duplication between main/renderer code.
 */

/**
 * File system related constants
 */
export const FILE_CONSTANTS = {
  /** Threshold for batch file changes before full tree reload */
  BATCH_CHANGE_THRESHOLD: 10,
  /** Debounce interval for file watcher events (ms) */
  WATCHER_DEBOUNCE_MS: 300,
} as const;

/**
 * ID generation configuration
 */
export const ID_CONSTANTS = {
  /** Length of random suffix in generated IDs */
  RANDOM_SUFFIX_LENGTH: 9,
  /** Slice start for random string extraction */
  RANDOM_SLICE_START: 2,
} as const;

/**
 * Preview and truncation size constants
 * Used for log previews, error messages, and data snippets
 */
export const PREVIEW_SIZES = {
  /** Tiny preview for minimal context (e.g., log prefixes) */
  TINY: 50,
  /** Small preview for brief context */
  SMALL: 100,
  /** Medium preview for moderate context */
  MEDIUM: 200,
  /** Standard preview size for general use */
  STANDARD: 500,
  /** Large preview for detailed context */
  LARGE: 1000,
  /** Extra large for comprehensive output */
  EXTRA_LARGE: 2000,
} as const;
