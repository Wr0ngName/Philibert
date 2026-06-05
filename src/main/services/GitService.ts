/**
 * Service for git operations via execFile.
 * Watches .git directory for changes and emits status updates.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type { GitStatus } from '../../shared/types';
import { MAIN_CONSTANTS } from '../constants/app';
import logger from '../utils/logger';
import { WindowsPaths } from '../utils/resourcePaths';

const execFileAsync = promisify(execFile);

export class GitService {
  private watchers: fs.FSWatcher[] = [];
  private watchedDir: string | null = null;
  private isFullyWatching = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private statusCallbacks: Set<(status: GitStatus) => void> = new Set();
  private resolvedGitBinary: string | null = null;

  constructor() {
    logger.info('GitService initialized');
  }

  /**
   * Resolve the git binary path. On Windows, prefer the bundled Git for
   * Windows so behavior is consistent across installs regardless of whether
   * the user has a system git on PATH. Falls back to PATH lookup otherwise.
   */
  private getGitBinary(): string {
    if (this.resolvedGitBinary !== null) {
      return this.resolvedGitBinary;
    }
    if (process.platform === 'win32' && WindowsPaths.hasBundledGit()) {
      this.resolvedGitBinary = WindowsPaths.getGitExe();
      logger.info('GitService using bundled git', { path: this.resolvedGitBinary });
    } else {
      this.resolvedGitBinary = 'git';
    }
    return this.resolvedGitBinary;
  }

  /**
   * Build the env for git subprocesses. On Windows we prepend the bundled
   * git-bash bin dirs so sh.exe, credential helpers, and other tools git
   * shells out to resolve from the bundle rather than (or before) system PATH.
   */
  private getGitEnv(): NodeJS.ProcessEnv {
    if (process.platform === 'win32' && WindowsPaths.hasBundledGitBash()) {
      return { ...process.env, PATH: WindowsPaths.buildEnhancedPath() };
    }
    return process.env;
  }

  /**
   * Run a git command safely via execFile (no shell injection)
   */
  private async runGit(args: string[], cwd: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.getGitBinary(), args, {
        cwd,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        env: this.getGitEnv(),
      });
      return stdout.trim();
    } catch (error) {
      const err = error as Error & { stderr?: string; code?: string };
      const message = err.stderr?.trim() || err.message;
      throw new Error(message, { cause: error });
    }
  }

  /**
   * Get git repository status
   */
  async getStatus(cwd: string): Promise<GitStatus> {
    // Check if directory is a git repo
    try {
      await this.runGit(['rev-parse', '--is-inside-work-tree'], cwd);
    } catch {
      return { isGitRepo: false, branch: '', dirty: 0, ahead: 0, behind: 0 };
    }

    // Get current branch
    let branch: string;
    try {
      branch = await this.runGit(['branch', '--show-current'], cwd);
      if (!branch) {
        // Detached HEAD
        const shortRef = await this.runGit(['rev-parse', '--short', 'HEAD'], cwd);
        branch = `(${shortRef})`;
      }
    } catch {
      branch = '(unknown)';
    }

    // Get dirty file count
    let dirty = 0;
    try {
      const porcelain = await this.runGit(['status', '--porcelain'], cwd);
      if (porcelain) {
        dirty = porcelain.split('\n').filter((line) => line.length > 0).length;
      }
    } catch {
      // Ignore
    }

    // Get ahead/behind counts
    const aheadBehind = await this.getAheadBehind(cwd, branch);
    const { ahead, behind } = aheadBehind;

    return { isGitRepo: true, branch, dirty, ahead, behind };
  }

  /**
   * Parse ahead/behind from rev-list output
   */
  private parseRevList(output: string): { ahead: number; behind: number } {
    const parts = output.split('\t');
    if (parts.length === 2) {
      return {
        behind: parseInt(parts[0], 10) || 0,
        ahead: parseInt(parts[1], 10) || 0,
      };
    }
    return { ahead: 0, behind: 0 };
  }

  /**
   * Get ahead/behind counts with fallback strategies:
   * 1. Try @{upstream} (configured tracking branch)
   * 2. Fallback to origin/<branch> (common convention)
   */
  private async getAheadBehind(
    cwd: string,
    branch: string
  ): Promise<{ ahead: number; behind: number }> {
    // Try configured upstream first
    try {
      const revList = await this.runGit(
        ['rev-list', '--count', '--left-right', '@{upstream}...HEAD'],
        cwd
      );
      return this.parseRevList(revList);
    } catch {
      // No upstream configured, try origin/<branch>
    }

    // Fallback: compare against origin/<branch>
    if (branch && !branch.startsWith('(')) {
      try {
        // Check if origin/<branch> ref exists
        await this.runGit(['rev-parse', '--verify', `origin/${branch}`], cwd);
        const revList = await this.runGit(
          ['rev-list', '--count', '--left-right', `origin/${branch}...HEAD`],
          cwd
        );
        return this.parseRevList(revList);
      } catch {
        // No remote ref either
      }
    }

    return { ahead: 0, behind: 0 };
  }

  /**
   * Fetch from remote (background operation to update remote tracking refs)
   */
  async fetch(cwd: string): Promise<void> {
    try {
      await this.runGit(['fetch', '--quiet'], cwd);
      logger.debug('Git fetch completed', { cwd });
    } catch (error) {
      // Fetch failures are non-critical (offline, no remote, etc.)
      logger.debug('Git fetch failed (non-critical)', { error: (error as Error).message });
    }
  }

  /**
   * Commit changes.
   * @param cwd Working directory
   * @param message Commit message
   * @param stageAll If true (default), stages all changes with `git add -A` first.
   *                 If false, commits only already-staged changes.
   */
  async commit(cwd: string, message: string, stageAll = true): Promise<string> {
    if (!message.trim()) {
      throw new Error('Commit message must not be empty');
    }

    if (stageAll) {
      await this.runGit(['add', '-A'], cwd);
    }

    const output = await this.runGit(['commit', '-m', message], cwd);
    logger.info('Git commit', { cwd, stageAll, message: message.slice(0, 50) });
    return output;
  }

  /**
   * Pull from remote
   */
  async pull(cwd: string): Promise<string> {
    const output = await this.runGit(['pull'], cwd);
    logger.info('Git pull', { cwd });
    return output;
  }

  /**
   * Push to remote
   */
  async push(cwd: string): Promise<string> {
    const output = await this.runGit(['push'], cwd);
    logger.info('Git push', { cwd });
    return output;
  }

  /**
   * Register a callback for git status changes
   */
  onStatusChange(callback: (status: GitStatus) => void): () => void {
    this.statusCallbacks.add(callback);
    return () => {
      this.statusCallbacks.delete(callback);
    };
  }

  /**
   * Start watching a git repository for changes.
   * Watches .git/HEAD, .git/index, and .git/refs/ for internal git events.
   * If not a git repo yet, watches the directory for .git to appear (git init).
   */
  startWatching(directory: string): void {
    this.stopWatching();
    this.watchedDir = directory;
    this.isFullyWatching = false;

    const gitDir = path.join(directory, '.git');

    try {
      fs.accessSync(gitDir);
    } catch {
      logger.debug('Not a git repo, watching for .git creation', { directory });
      this.watchForGitInit(directory);
      return;
    }

    this.setupGitWatchers(directory);
  }

  /**
   * Set up watchers on .git internals (called when .git exists)
   */
  private setupGitWatchers(directory: string): void {
    const gitDir = path.join(directory, '.git');

    // Watch .git/HEAD (branch switches)
    this.watchFile(path.join(gitDir, 'HEAD'));

    // Watch .git/index (staging area changes)
    this.watchFile(path.join(gitDir, 'index'));

    // Watch .git/refs/ recursively (commits, pushes, remote updates)
    const refsDir = path.join(gitDir, 'refs');
    try {
      fs.accessSync(refsDir);
      const watcher = fs.watch(refsDir, { recursive: true }, () => {
        this.scheduleStatusRefresh();
      });
      watcher.on('error', (err) => {
        logger.debug('Git refs watcher error', { error: err.message });
      });
      this.watchers.push(watcher);
    } catch {
      logger.debug('Cannot watch .git/refs/', { directory });
    }

    // Also watch .git/FETCH_HEAD for fetch completions
    this.watchFile(path.join(gitDir, 'FETCH_HEAD'));

    this.isFullyWatching = true;
    logger.info('Started watching git directory', { directory });

    // Do an initial background fetch so ahead/behind is accurate
    this.fetch(directory).then(() => {
      this.scheduleStatusRefresh();
    });
  }

  /**
   * Watch the working directory for .git to appear (handles git init while app is open)
   */
  private watchForGitInit(directory: string): void {
    try {
      const watcher = fs.watch(directory, (_eventType, filename) => {
        if (filename === '.git') {
          const gitDir = path.join(directory, '.git');
          // Verify .git is actually a directory (not just a transient event)
          try {
            const stat = fs.statSync(gitDir);
            if (stat.isDirectory()) {
              logger.info('Git repo detected (git init)', { directory });
              // Close the init watcher, set up full git watchers
              watcher.close();
              // Remove this watcher from the array
              const idx = this.watchers.indexOf(watcher);
              if (idx !== -1) this.watchers.splice(idx, 1);
              // Set up full git watchers
              this.setupGitWatchers(directory);
              // Immediately emit the new status
              this.scheduleStatusRefresh();
            }
          } catch {
            // .git doesn't exist yet or not accessible, ignore
          }
        }
      });
      watcher.on('error', (err) => {
        logger.debug('Git init watcher error', { error: err.message });
      });
      this.watchers.push(watcher);
    } catch (err) {
      logger.debug('Cannot watch for git init', { directory, error: (err as Error).message });
    }
  }

  /**
   * Watch a single file for changes
   */
  private watchFile(filePath: string): void {
    try {
      fs.accessSync(filePath);
      const watcher = fs.watch(filePath, () => {
        this.scheduleStatusRefresh();
      });
      watcher.on('error', (err) => {
        logger.debug('Git file watcher error', { file: filePath, error: err.message });
      });
      this.watchers.push(watcher);
    } catch {
      logger.debug('Cannot watch git file', { filePath });
    }
  }

  /**
   * Debounce status refresh to avoid rapid-fire updates
   */
  private scheduleStatusRefresh(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      if (!this.watchedDir) return;

      try {
        const status = await this.getStatus(this.watchedDir);
        for (const callback of this.statusCallbacks) {
          try {
            callback(status);
          } catch (error) {
            logger.error('Error in git status callback', { error });
          }
        }
      } catch (error) {
        logger.error('Failed to refresh git status', { error });
      }
    }, MAIN_CONSTANTS.FILES.WATCHER_DEBOUNCE_MS);
  }

  /**
   * Trigger a manual status refresh (called after file watcher events).
   * If not fully watching yet, checks if .git appeared and starts watching.
   */
  triggerRefresh(): void {
    if (this.watchedDir && !this.isFullyWatching) {
      // Not watching .git internals yet — check if .git appeared
      const gitDir = path.join(this.watchedDir, '.git');
      try {
        const stat = fs.statSync(gitDir);
        if (stat.isDirectory()) {
          logger.info('Git repo appeared, starting watchers', { dir: this.watchedDir });
          // Close existing init watcher, set up full watchers
          for (const w of this.watchers) {
            try { w.close(); } catch { /* ignore */ }
          }
          this.watchers = [];
          this.setupGitWatchers(this.watchedDir);
        }
      } catch {
        // Still no .git
      }
    }
    this.scheduleStatusRefresh();
  }

  /**
   * Stop watching
   */
  stopWatching(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // Ignore close errors
      }
    }
    this.watchers = [];
    this.watchedDir = null;
    this.isFullyWatching = false;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    logger.debug('Stopped watching git directory');
  }

  /**
   * Get the currently watched directory
   */
  getWatchedDirectory(): string | null {
    return this.watchedDir;
  }
}

export default GitService;
