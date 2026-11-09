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

/** Folder watches added in one go before the walk hands the thread back. */
const WATCHES_PER_TURN = 100;

export interface FileWatcherOptions {
  /**
   * Watch each folder on its own, walking the tree asynchronously, rather
   * than with one recursive fs.watch. The default on Linux, where Node
   * builds a recursive watch itself: synchronously, inside the call, one
   * inotify watch per file and folder, ignored folders included. A folder
   * of 100,000 entries froze the whole window for two seconds a call, and
   * Electron runs the main process's JavaScript on the thread that takes
   * the window's input. Windows and macOS watch a tree natively, with one
   * handle, so they keep it.
   */
  perFolder?: boolean;
}

export class FileWatcherService {
  /** The one recursive watcher (Windows, macOS). */
  private watcher: fs.FSWatcher | null = null;
  /** One watcher per folder (Linux), by folder. */
  private folderWatchers: Map<string, fs.FSWatcher> = new Map();
  /** Bumped by every watch and stop: a walk of an earlier folder stops. */
  private walkGeneration = 0;
  /** The walk setting up the per-folder watches, while it runs. */
  private walk: Promise<void> = Promise.resolve();
  private readonly perFolder: boolean;
  private watchedDirectory: string | null = null;
  private changeCallbacks: Set<(changes: FileChange[]) => void> = new Set();
  private pendingChanges: Map<string, FileChange> = new Map();
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(options: FileWatcherOptions = {}) {
    this.perFolder = options.perFolder ?? process.platform === 'linux';
    logger.info('FileWatcherService initialized', { perFolder: this.perFolder });
  }

  /**
   * Start watching a directory. Returns at once: per folder, the folders are
   * watched as the walk reaches them.
   */
  watch(directory: string): void {
    // Stop existing watcher
    this.stop();

    const normalizedDir = normalizePath(directory);
    this.watchedDirectory = normalizedDir;

    if (this.perFolder) {
      const generation = this.walkGeneration;
      const started = Date.now();
      this.walk = this.watchTree(normalizedDir, normalizedDir, generation, { sinceYield: 0 }).then(() => {
        if (generation !== this.walkGeneration) return;
        logger.info('Started watching directory', {
          directory: normalizedDir, folders: this.folderWatchers.size, ms: Date.now() - started,
        });
      });
      return;
    }

    try {
      this.watcher = fs.watch(normalizedDir, { recursive: true }, (eventType, filename) => {
        if (filename) {
          this.handleChange(eventType, filename, normalizedDir);
        }
      });

      logger.info('Started watching directory', { directory: normalizedDir, recursive: true });

      this.watcher.on('error', (error) => {
        logger.error('File watcher error', error);
      });

      this.watcher.on('close', () => {
        logger.info('File watcher closed');
      });
    } catch (error) {
      this.watchedDirectory = null;
      logger.error('Failed to start file watcher', error);
    }
  }

  /**
   * Watch `dir` and every folder under it that is not ignored, handing the
   * thread back every few watches so the window never waits on the walk.
   */
  private async watchTree(
    dir: string,
    root: string,
    generation: number,
    turn: { sinceYield: number },
  ): Promise<void> {
    if (generation !== this.walkGeneration || this.folderWatchers.has(dir)) return;
    try {
      const watcher = fs.watch(dir, (eventType, filename) => {
        if (filename) this.handleChange(eventType, path.relative(root, path.join(dir, filename.toString())), root);
      });
      watcher.on('error', (error) => {
        // A folder removed while watched ends its watcher this way.
        logger.debug('Folder watcher ended', { dir, error });
        this.unwatchFolder(dir);
      });
      this.folderWatchers.set(dir, watcher);
    } catch (error) {
      // ENOSPC: the system's inotify limit. What is watched so far stays.
      logger.warn('Could not watch folder', { dir, error });
      return;
    }

    turn.sinceYield += 1;
    if (turn.sinceYield >= WATCHES_PER_TURN) {
      turn.sinceYield = 0;
      await new Promise((resolve) => setImmediate(resolve));
    }

    let entries: fs.Dir;
    try {
      entries = await fs.promises.opendir(dir);
    } catch {
      return;
    }
    for await (const entry of entries) {
      if (generation !== this.walkGeneration) return;
      if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) {
        await this.watchTree(path.join(dir, entry.name), root, generation, turn);
      }
    }
  }

  /** Stop watching a folder and every folder under it. */
  private unwatchFolder(dir: string): void {
    for (const [watched, watcher] of this.folderWatchers) {
      if (watched === dir || watched.startsWith(`${dir}${path.sep}`)) {
        watcher.close();
        this.folderWatchers.delete(watched);
      }
    }
  }

  /**
   * Stop watching
   */
  stop(): void {
    this.walkGeneration += 1;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.folderWatchers.size > 0) {
      for (const watcher of this.folderWatchers.values()) watcher.close();
      this.folderWatchers.clear();
    }
    if (this.watchedDirectory) {
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

    // Per folder, a folder that appears is watched too, and one that goes is let go.
    if (this.perFolder && this.watchedDirectory) {
      if (change.kind === 'directory' && change.type === 'add') {
        void this.watchTree(fullPath, baseDir, this.walkGeneration, { sinceYield: 0 });
      } else if (change.type === 'unlink') {
        this.unwatchFolder(fullPath);
      }
    }

    // Add to pending changes (debounce). A new file is reported as it is
    // created ('rename') and again as it is written ('change'): it stays an
    // addition, or the tree, which adds rows only for additions, never
    // showed a file created while it was open.
    const pending = this.pendingChanges.get(fullPath);
    this.pendingChanges.set(fullPath, pending?.type === 'add' && change.type === 'change' ? pending : change);

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

  /** Settles once every folder of the watched directory is watched. */
  whenWatching(): Promise<void> {
    return this.walk;
  }

  /** How many folders are watched on their own (per folder only). */
  watchedFolderCount(): number {
    return this.folderWatchers.size;
  }
}

export default FileWatcherService;
