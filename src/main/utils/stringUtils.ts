/**
 * String Utility Functions
 *
 * Common string manipulation utilities used across the main process.
 * Centralizes patterns that were duplicated in multiple services.
 */

import { PREVIEW_SIZES } from '../../shared/constants';

/**
 * Truncate a string to a maximum length with ellipsis.
 *
 * @param str - The string to truncate
 * @param maxLength - Maximum length (defaults to PREVIEW_SIZES.STANDARD)
 * @param ellipsis - The ellipsis string (defaults to '...')
 * @returns The truncated string
 *
 * @example
 * truncate('Hello World', 8) // => 'Hello...'
 * truncate('Short', 10)      // => 'Short'
 */
export function truncate(
  str: string,
  maxLength: number = PREVIEW_SIZES.STANDARD,
  ellipsis: string = '...'
): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength - ellipsis.length) + ellipsis;
}

/**
 * Truncate string for preview/logging with configurable size.
 *
 * @param str - The string to preview
 * @param size - Preview size from PREVIEW_SIZES (defaults to STANDARD)
 * @returns Truncated string suitable for logging
 *
 * @example
 * preview(longErrorMessage, PREVIEW_SIZES.SMALL) // => first 100 chars + '...'
 */
export function preview(str: string, size: number = PREVIEW_SIZES.STANDARD): string {
  return truncate(str, size, '...');
}

/**
 * Sanitize a string for safe log output.
 * Replaces non-printable characters with '?' for readability.
 *
 * @param str - The string to sanitize
 * @param maxLength - Maximum length (defaults to 100)
 * @returns Sanitized string safe for logging
 */
export function sanitizeForLog(str: string, maxLength: number = PREVIEW_SIZES.SMALL): string {
  return Array.from(str.slice(0, maxLength))
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126 ? '?' : c))
    .join('');
}
