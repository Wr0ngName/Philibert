/**
 * File watcher service for monitoring file system changes
 * Uses Node.js fs.watch with debouncing
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FileChange, FileNode } from '../../shared/types';
import { MAIN_CONSTANTS } from '../constants/app';
import { FileSystemError, ERROR_CODES } from '../errors';
import logger from '../utils/logger';
import { isPathWithin, normalizePath } from '../utils/paths';

// Directories to ignore when watching/scanning
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.vite',
  '.next',
  '.nuxt',
  '__pycache__',
  '.pytest_cache',
  'venv',
  '.venv',
  'coverage',
  '.nyc_output',
]);

// Files to ignore
const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', '.gitkeep']);

/** The tree's order: directories first, then files, each alphabetically. */
export function compareNodes(a: Pick<FileNode, 'name' | 'type'>, b: Pick<FileNode, 'name' | 'type'>): number {
  if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export class FileWatcherService {
  private watcher: fs.FSWatcher | null = null;
  private watchedDirectory: string | null = null;
  private changeCallbacks: Set<(changes: FileChange[]) => void> = new Set();
  private pendingChanges: Map<string, FileChange> = new Map();
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor() {
    logger.info('FileWatcherService initialized');
  }

  /**
   * Start watching a directory
   */
  watch(directory: string): void {
    // Stop existing watcher
    this.stop();

    const normalizedDir = normalizePath(directory);

    try {
      this.watcher = fs.watch(normalizedDir, { recursive: true }, (eventType, filename) => {
        if (filename) {
          this.handleChange(eventType, filename, normalizedDir);
        }
      });

      this.watchedDirectory = normalizedDir;
      logger.info('Started watching directory', { directory: normalizedDir, recursive: true });

      this.watcher.on('error', (error) => {
        logger.error('File watcher error', error);
      });

      this.watcher.on('close', () => {
        logger.info('File watcher closed');
      });
    } catch (error) {
      logger.error('Failed to start file watcher', error);
    }
  }

  /**
   * Stop watching
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      this.watchedDirectory = null;
      logger.info('Stopped file watcher');
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.pendingChanges.clear();
  }

  /**
   * Handle file system change event
   */
  private handleChange(eventType: string, filename: string, baseDir: string): void {
    // Normalize path separators (Windows fs.watch can return mixed separators)
    const normalizedFilename = filename.replace(/\\/g, '/').replace(/\//g, path.sep);
    const fullPath = path.join(baseDir, normalizedFilename);

    if (this.shouldIgnore(normalizedFilename)) {
      return;
    }

    logger.debug('File watcher event', { eventType, filename, normalizedFilename, fullPath });

    // Determine change type, and what the path is while it exists: the tree
    // used to guess a new path's kind from whether its name had a dot in it.
    let change: FileChange;
    try {
      const stats = fs.statSync(fullPath);
      change = {
        type: eventType === 'rename' ? 'add' : 'change',
        path: fullPath,
        kind: stats.isDirectory() ? 'directory' : 'file',
      };
    } catch {
      change = { type: 'unlink', path: fullPath };
    }

    logger.debug('File change detected', { changeType: change.type, fullPath });

    // Add to pending changes (debounce)
    this.pendingChanges.set(fullPath, change);

    // Debounce the notification
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.flushChanges();
    }, MAIN_CONSTANTS.FILES.WATCHER_DEBOUNCE_MS);
  }

  /**
   * Flush pending changes to callbacks
   */
  private flushChanges(): void {
    if (this.pendingChanges.size === 0) {
      return;
    }

    const changes = Array.from(this.pendingChanges.values());
    this.pendingChanges.clear();

    logger.debug('File changes detected', { count: changes.length });

    for (const callback of this.changeCallbacks) {
      try {
        callback(changes);
      } catch (error) {
        logger.error('Error in file change callback', error);
      }
    }
  }

  /**
   * Check if a path should be ignored
   */
  private shouldIgnore(relativePath: string): boolean {
    // Normalize separators and split - handle both Windows and Unix paths
    const normalizedPath = relativePath.replace(/\\/g, '/');
    const parts = normalizedPath.split('/');

    for (const part of parts) {
      if (IGNORED_DIRS.has(part) || IGNORED_FILES.has(part)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Register a callback for file changes
   */
  onChange(callback: (changes: FileChange[]) => void): () => void {
    this.changeCallbacks.add(callback);
    return () => {
      this.changeCallbacks.delete(callback);
    };
  }

  /**
   * The entries of one directory, one level deep: directories first, then
   * files, each alphabetically. Directories come back without their entries,
   * which are read when the directory is opened.
   *
   * The tree used to be read whole, up to ten levels deep with a stat of
   * every file, before anything was shown: in a repository of tens of
   * thousands of files that took seconds, and was sent across in one piece.
   * One level is one readdir.
   *
   * `directory` must be `workingDirectory` or inside it.
   */
  async listDirectory(directory: string, workingDirectory: string): Promise<FileNode[]> {
    const dir = normalizePath(directory);
    if (!isPathWithin(dir, normalizePath(workingDirectory))) {
      throw new FileSystemError('Access denied: directory is outside the working directory', dir, ERROR_CODES.FS_PATH_TRAVERSAL);
    }

    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const nodes: FileNode[] = [];
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name) || IGNORED_FILES.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        nodes.push({ name: entry.name, path: fullPath, type: 'directory' });
      } else if (entry.isFile()) {
        nodes.push({ name: entry.name, path: fullPath, type: 'file' });
      }
    }
    return nodes.sort(compareNodes);
  }

  /**
   * Read file content with security check
   */
  async readFile(filePath: string, workingDir: string): Promise<string> {
    const normalizedPath = normalizePath(filePath);
    const normalizedWorkDir = normalizePath(workingDir);

    // Security: ensure the file is within the working directory or the Claude SDK temp directory
    // (task output files are stored in <tmpdir>/claude/... by the SDK)
    const claudeTempDir = normalizePath(path.join(os.tmpdir(), 'claude'));
    const isInWorkingDir = isPathWithin(normalizedPath, normalizedWorkDir);
    const isClaudeTaskOutput = isPathWithin(normalizedPath, claudeTempDir);

    if (!isInWorkingDir && !isClaudeTaskOutput) {
      throw new FileSystemError('Access denied: file is outside working directory', normalizedPath, ERROR_CODES.FS_PATH_TRAVERSAL);
    }

    try {
      const content = await fs.promises.readFile(normalizedPath, 'utf-8');
      return content;
    } catch (error) {
      logger.error('Failed to read file', { filePath, error });
      throw new FileSystemError(`Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`, normalizedPath, ERROR_CODES.FS_READ_FAILED, error);
    }
  }

  /**
   * Get the currently watched directory
   */
  getWatchedDirectory(): string | null {
    return this.watchedDirectory;
  }
}

export default FileWatcherService;
