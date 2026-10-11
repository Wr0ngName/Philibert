/**
 * Unified ID generation utility
 *
 * Provides consistent ID generation across main and renderer processes.
 * All IDs follow the format: {prefix}_{timestamp_base36}_{random_base36}
 */

import { ID_CONSTANTS } from './constants';

/**
 * Generate a unique ID with a prefix
 *
 * @param prefix - The prefix to prepend to the ID (e.g., 'conv', 'msg', 'action')
 * @returns A unique ID in format: prefix_timestamp_random
 *
 * @example
 * generateId('conv') // => 'conv_m5x2abc_8f3k2j9xl'
 * generateId('msg')  // => 'msg_m5x2abd_2j8k3l5xp'
 */
export function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random()
    .toString(36)
    .slice(ID_CONSTANTS.RANDOM_SLICE_START, ID_CONSTANTS.RANDOM_SLICE_START + ID_CONSTANTS.RANDOM_SUFFIX_LENGTH);
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * Common ID prefixes used throughout the application
 */
export const ID_PREFIXES = {
  /** Conversation ID prefix */
  CONVERSATION: 'conv',
  /** Message ID prefix */
  MESSAGE: 'msg',
  /** Action ID prefix (for permission requests) */
  ACTION: 'action',
  /** Modal ID prefix */
  MODAL: 'modal',
  /** Queued-prompt ID prefix (a prompt written during a running turn) */
  QUEUED_PROMPT: 'queued',
} as const;
