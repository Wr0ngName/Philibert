/**
 * IPC helper utilities for main process.
 */

import type { BrowserWindow } from 'electron';

import { ConfigurationError, ValidationError, ERROR_CODES } from '../errors';

import logger from './logger';

/**
 * Safely send a message to the renderer process.
 * Handles window existence and destruction checks.
 *
 * @param getMainWindow - Function to get the main window reference
 * @param channel - IPC channel name
 * @param data - Data to send
 * @returns true if message was sent, false otherwise
 */
export function sendToRenderer(
  getMainWindow: () => BrowserWindow | null,
  channel: string,
  ...args: unknown[]
): boolean {
  const window = getMainWindow();

  if (!window) {
    logger.debug('Cannot send to renderer: no main window', { channel });
    return false;
  }

  if (window.isDestroyed()) {
    logger.debug('Cannot send to renderer: window is destroyed', { channel });
    return false;
  }

  try {
    window.webContents.send(channel, ...args);
    return true;
  } catch (error) {
    logger.error('Failed to send to renderer', { channel, error });
    return false;
  }
}

/**
 * Create a bound sendToRenderer function for a specific window getter.
 *
 * @param getMainWindow - Function to get the main window reference
 * @returns Bound send function
 */
export function createSender(
  getMainWindow: () => BrowserWindow | null
): (channel: string, ...args: unknown[]) => boolean {
  return (channel: string, ...args: unknown[]) =>
    sendToRenderer(getMainWindow, channel, ...args);
}

/**
 * Validate that a value is a non-empty string.
 *
 * @param value - Value to validate
 * @param fieldName - Name of the field for error messages
 * @throws Error if validation fails
 */
export function validateString(
  value: unknown,
  fieldName: string,
  options?: { allowEmpty?: boolean },
): asserts value is string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${fieldName} must be a string`, fieldName, ERROR_CODES.VALIDATION_TYPE_MISMATCH);
  }
  // Empty is normally a caller mistake. The exception is a message that is
  // only attachments — a screenshot with no question is a real thing to send,
  // and refusing it would make the attachment useless on its own.
  if (!options?.allowEmpty && value.trim().length === 0) {
    throw new ValidationError(`${fieldName} must not be empty`, fieldName, ERROR_CODES.VALIDATION_REQUIRED);
  }
}

/**
 * Validate that a value is an object.
 *
 * @param value - Value to validate
 * @param fieldName - Name of the field for error messages
 * @throws Error if validation fails
 */
export function validateObject(
  value: unknown,
  fieldName: string
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new ValidationError(`${fieldName} must be an object`, fieldName, ERROR_CODES.VALIDATION_TYPE_MISMATCH);
  }
}

/**
 * Validate that a path is safe (no path traversal).
 *
 * @param filePath - Path to validate
 * @throws Error if path contains traversal patterns
 */
export function validatePath(filePath: string): void {
  const normalized = filePath.replace(/\\/g, '/');

  if (normalized.includes('../') || normalized.includes('..\\')) {
    throw new ValidationError('Invalid path: path traversal not allowed', 'filePath', ERROR_CODES.FS_PATH_TRAVERSAL);
  }

  // Check for null bytes (path injection)
  if (filePath.includes('\0')) {
    throw new ValidationError('Invalid path: null bytes not allowed', 'filePath', ERROR_CODES.VALIDATION_INVALID_PATH);
  }
}

/**
 * Validate that a value is a boolean.
 *
 * @param value - Value to validate
 * @param fieldName - Name of the field for error messages
 * @throws Error if validation fails
 */
export function validateBoolean(value: unknown, fieldName: string): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${fieldName} must be a boolean`, fieldName, ERROR_CODES.VALIDATION_TYPE_MISMATCH);
  }
}

/**
 * Validate that a value is a number within optional bounds.
 *
 * @param value - Value to validate
 * @param fieldName - Name of the field for error messages
 * @param options - Optional min/max constraints
 * @throws Error if validation fails
 */
export function validateNumber(
  value: unknown,
  fieldName: string,
  options?: { min?: number; max?: number }
): asserts value is number {
  if (typeof value !== 'number' || isNaN(value)) {
    throw new ValidationError(`${fieldName} must be a number`, fieldName, ERROR_CODES.VALIDATION_TYPE_MISMATCH);
  }
  if (options?.min !== undefined && value < options.min) {
    throw new ValidationError(`${fieldName} must be >= ${options.min}`, fieldName, ERROR_CODES.VALIDATION_TYPE_MISMATCH);
  }
  if (options?.max !== undefined && value > options.max) {
    throw new ValidationError(`${fieldName} must be <= ${options.max}`, fieldName, ERROR_CODES.VALIDATION_TYPE_MISMATCH);
  }
}

/**
 * Validate that a value is an array.
 *
 * @param value - Value to validate
 * @param fieldName - Name of the field for error messages
 * @throws Error if validation fails
 */
export function validateArray(value: unknown, fieldName: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${fieldName} must be an array`, fieldName, ERROR_CODES.VALIDATION_TYPE_MISMATCH);
  }
}

/**
 * Get a human-readable error message from an unknown error.
 *
 * @param error - The error to extract message from
 * @returns Human-readable error message
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Format an error message with a prefix.
 *
 * @param prefix - Prefix for the error message (e.g., "Failed to load config")
 * @param error - The original error
 * @returns Formatted error message
 */
export function formatErrorMessage(prefix: string, error: unknown): string {
  return `${prefix}: ${getErrorMessage(error)}`;
}

/**
 * Error to throw from a handler that reads or writes project settings files.
 * Preserves the message of errors the service raised deliberately — they are
 * written for the user and shown verbatim — and wraps anything else.
 */
export function toSettingsIpcError(prefix: string, error: unknown): Error {
  if (error instanceof ConfigurationError) return error;
  if (error instanceof ValidationError) return error;
  return new ConfigurationError(
    formatErrorMessage(prefix, error),
    ERROR_CODES.CONFIG_SAVE_FAILED,
    error
  );
}

/**
 * Validate that a service is initialized.
 * Use this at the start of IPC handlers to ensure services are ready.
 *
 * @param service - The service instance to check
 * @param serviceName - Name of the service for error messages
 * @throws ValidationError if service is not initialized
 *
 * @example
 * ```typescript
 * ensureService(configService, 'ConfigService');
 * ensureService(claudeService, 'ClaudeCodeService');
 * ```
 */
export function ensureService<T>(
  service: T | null | undefined,
  serviceName: string
): asserts service is T {
  if (!service) {
    throw new ValidationError(
      `${serviceName} not initialized`,
      serviceName,
      ERROR_CODES.IPC_HANDLER_FAILED
    );
  }
}
