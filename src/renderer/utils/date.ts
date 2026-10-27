/**
 * Date formatting utilities
 *
 * Provides consistent date formatting across the application.
 */

import { TIME_MS } from '../constants/app';

/**
 * Format options for the date formatter
 */
export type DateFormatStyle = 'relative' | 'time' | 'date' | 'datetime';

/**
 * Formatters, built once per set of options.
 *
 * `toLocaleTimeString(locales, options)` builds a new Intl.DateTimeFormat on
 * every call, and that is the expensive part: the discussion formats one time
 * per message it renders, and with a window of hundreds of messages that was
 * the largest cost of rendering it after the DOM itself (profiled 2026-10-27).
 * The locale is the default one, as `[]` gave before.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat([], options);
    formatters.set(key, formatter);
  }
  return formatter;
}

/**
 * Format a timestamp as a time string (HH:MM)
 *
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Formatted time string like "2:30 PM"
 */
export function formatTime(timestamp: number): string {
  return formatterFor({ hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

/**
 * Format a timestamp as a date string
 *
 * @param timestamp - Unix timestamp in milliseconds
 * @param options - Intl.DateTimeFormat options
 * @returns Formatted date string
 */
export function formatDate(
  timestamp: number,
  options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
): string {
  return formatterFor(options).format(timestamp);
}

/**
 * Format a timestamp as a relative date string
 *
 * Shows:
 * - Time (HH:MM) for today
 * - "Yesterday" for yesterday
 * - Weekday name for this week
 * - Month and day for older dates
 *
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Human-readable relative date string
 */
export function formatRelativeDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  // Today - show time
  if (diff < TIME_MS.ONE_DAY && date.getDate() === now.getDate()) {
    return formatTime(timestamp);
  }

  // Yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear()
  ) {
    return 'Yesterday';
  }

  // This week - show weekday
  if (diff < TIME_MS.ONE_WEEK) {
    return formatDate(timestamp, { weekday: 'short' });
  }

  // Older - show month and day
  return formatDate(timestamp, { month: 'short', day: 'numeric' });
}

/**
 * Format a timestamp as a full datetime string
 *
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Formatted datetime string like "Jan 15, 2024, 2:30 PM"
 */
export function formatDateTime(timestamp: number): string {
  return formatterFor({
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

/**
 * Format a duration in milliseconds as a human-readable string
 *
 * @param durationMs - Duration in milliseconds
 * @returns Formatted duration like "2m 30s" or "1h 15m"
 */
export function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }

  if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }

  return `${seconds}s`;
}
