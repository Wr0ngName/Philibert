/**
 * Path utilities for cross-platform path handling
 */

import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

/**
 * Get the user data directory for storing app data
 */
export function getUserDataPath(): string {
  return app.getPath('userData');
}

/**
 * Get the path to store conversations
 */
export function getConversationsPath(): string {
  return path.join(getUserDataPath(), 'conversations');
}

/**
 * Get the path to store configuration
 */
export function getConfigPath(): string {
  return path.join(getUserDataPath(), 'config');
}

/**
 * Get the path to store logs
 */
export function getLogsPath(): string {
  return path.join(getUserDataPath(), 'logs');
}

/**
 * Normalize a path for the current platform
 */
export function normalizePath(inputPath: string): string {
  return path.normalize(inputPath);
}

/**
 * Check if a path is within a directory (security check).
 * Resolves symlinks to prevent path traversal attacks.
 *
 * @param filePath - The file path to check
 * @param directory - The directory that should contain the file
 * @returns true if the file is within the directory
 */
export function isPathWithin(filePath: string, directory: string): boolean {
  try {
    // Resolve real paths including symlinks for security
    const realFile = fs.realpathSync(filePath);
    const realDir = fs.realpathSync(directory);

    // Use relative path to check containment
    const relative = path.relative(realDir, realFile);

    // If relative path starts with '..' or is absolute, file is outside directory
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    // If paths don't exist yet, fall back to string comparison
    // This is less secure but allows checking non-existent paths
    const normalizedFile = path.resolve(filePath);
    const normalizedDir = path.resolve(directory);
    return (
      normalizedFile.startsWith(normalizedDir + path.sep) || normalizedFile === normalizedDir
    );
  }
}

/**
 * Get a relative path from a base directory
 */
export function getRelativePath(filePath: string, baseDir: string): string {
  return path.relative(baseDir, filePath);
}
