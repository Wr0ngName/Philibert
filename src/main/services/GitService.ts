/**
 * Service for git operations via execFile.
 * Watches .git directory for changes and emits status updates.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type { GitBranch, GitCredentialRequest, GitRemoteResult, GitStatus } from '../../shared/types';
import { MAIN_CONSTANTS } from '../constants/app';
import logger from '../utils/logger';
import { WindowsPaths } from '../utils/resourcePaths';

import type { CredentialSession, GitCredentialBroker } from './git/GitCredentialBroker';
import { describeHelper, effectiveHelpers, keepsLogin, parseHelperConfig } from './git/credential-helpers';

const execFileAsync = promisify(execFile);

/**
 * Detect git's "identity not configured" failure modes from an error message.
 *
 * Git renders these from src/ident.c / builtin/commit.c — known phrasings:
 *   - "Please tell me who you are."
 *   - "fatal: unable to auto-detect email address"
 *   - "fatal: empty ident name"
 *   - "fatal: no email was given"
 *
 * Exported so the renderer error toast can branch on it via a dedicated IPC.
 */
export function isIdentityError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('please tell me who you are')
    || m.includes('unable to auto-detect email')
    || m.includes('empty ident name')
    || m.includes('no email was given')
    || m.includes('no name was given');
}

export class GitService {
  private watchers: fs.FSWatcher[] = [];
  private watchedDir: string | null = null;
  private isFullyWatching = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private remoteFetchInterval: NodeJS.Timeout | null = null;
  private statusCallbacks: Set<(status: GitStatus) => void> = new Set();
  private resolvedGitBinary: string | null = null;

  /**
   * @param credentials Asks the user for a login during a push or pull.
   *   Without it, those fail when git has no login, as other commands do.
   */
  constructor(readonly credentials: GitCredentialBroker | null = null) {
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
   *
   * No git command may prompt on its own. There is no terminal to prompt on,
   * and the user's own prompters (Git Credential Manager's window, an ssh
   * askpass dialog) would pop up from background work — the periodic fetch
   * of a private repository opening a sign-in window every minute. A push or
   * pull asks through Philibert instead (GitCredentialBroker).
   */
  private getGitEnv(): NodeJS.ProcessEnv {
    const noPrompts = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never' };
    if (process.platform === 'win32' && WindowsPaths.hasBundledGitBash()) {
      return { ...process.env, PATH: WindowsPaths.buildEnhancedPath(), ...noPrompts };
    }
    return { ...process.env, ...noPrompts };
  }

  /**
   * Run a git command safely via execFile (no shell injection).
   *
   * With a credential session, git may ask Philibert for a login, and the
   * command gets the longer timeout of a push or pull.
   */
  private async runGit(args: string[], cwd: string, session?: CredentialSession): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.getGitBinary(), [...(session?.configArgs ?? []), ...args], {
        cwd,
        timeout: session ? MAIN_CONSTANTS.GIT.REMOTE_OPERATION_TIMEOUT_MS : MAIN_CONSTANTS.GIT.COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: { ...this.getGitEnv(), ...session?.env },
      });
      return stdout.trim();
    } catch (error) {
      const err = error as Error & { stderr?: string; code?: string };
      const message = err.stderr?.trim() || err.message;
      throw new Error(message, { cause: error });
    }
  }

  /**
   * What will keep a login for a host in this repository: the user's
   * credential helpers as git's configuration (system, global, local) lists
   * them. `git config` exits 1 when there are none, which is an answer too.
   */
  private async credentialKeeping(cwd: string, host: string): Promise<GitCredentialRequest['keeping']> {
    let output = '';
    try {
      output = await this.runGit(['config', '--get-regexp', '^credential\\..*helper$'], cwd);
    } catch (error) {
      if ((error as Error & { cause?: { code?: unknown } }).cause?.code !== 1) throw error;
    }
    const helpers = effectiveHelpers(parseHelperConfig(output), host);
    return { helpers: helpers.map(describeHelper), remembered: keepsLogin(helpers) };
  }

  /**
   * A push or pull: the command that may need a login, run so it can ask
   * the user for one, with the outcome as a result rather than a throw — a
   * failure says when it was the login's.
   */
  private async runRemote(args: string[], cwd: string, expectedBranch: string | undefined): Promise<GitRemoteResult> {
    try {
      await this.assertCurrentBranch(cwd, expectedBranch);
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }

    let session: CredentialSession | undefined;
    try {
      session = await this.credentials?.begin((host) => this.credentialKeeping(cwd, host));
    } catch (error) {
      // Without the broker the command still runs; it just cannot ask.
      logger.warn('Git credential broker unavailable', { error: (error as Error).message });
    }
    try {
      const output = await this.runGit(args, cwd, session);
      return { ok: true, output };
    } catch (error) {
      const auth = session?.authFailure();
      return { ok: false, error: (error as Error).message, ...(auth ? { auth } : {}) };
    } finally {
      session?.end();
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
   * Read HEAD's branch name. Returns null when HEAD is detached.
   */
  private async getCurrentBranch(cwd: string): Promise<string | null> {
    try {
      return await this.runGit(['symbolic-ref', '--short', 'HEAD'], cwd);
    } catch {
      return null;
    }
  }

  /**
   * Backstop check that the renderer's expected branch still matches HEAD
   * just before a destructive op (push/pull/commit). Closes the renderer-side
   * time-of-check-to-time-of-use window between the UI's preflight and the
   * IPC dispatch.
   */
  private async assertCurrentBranch(cwd: string, expected: string | undefined): Promise<void> {
    if (expected === undefined) return;
    const current = await this.getCurrentBranch(cwd);
    if (current !== expected) {
      throw new Error(
        `Branch changed from "${expected}" to "${current ?? '(detached HEAD)'}" — operation aborted to avoid acting on the wrong branch.`
      );
    }
  }

  /**
   * Commit changes.
   * @param cwd Working directory
   * @param message Commit message
   * @param stageAll If true (default), stages all changes with `git add -A` first.
   *                 If false, commits only already-staged changes.
   * @param expectedBranch If set, abort unless HEAD currently points at this branch.
   */
  async commit(
    cwd: string,
    message: string,
    stageAll = true,
    expectedBranch?: string
  ): Promise<string> {
    if (!message.trim()) {
      throw new Error('Commit message must not be empty');
    }
    await this.assertCurrentBranch(cwd, expectedBranch);

    if (stageAll) {
      await this.runGit(['add', '-A'], cwd);
    }

    const output = await this.runGit(['commit', '-m', message], cwd);
    logger.info('Git commit', { cwd, stageAll, message: message.slice(0, 50) });
    return output;
  }

  /**
   * Read git's user.name / user.email config for a working directory.
   *
   * Falls through git's normal precedence (local repo → global → system).
   * Empty strings indicate the value isn't set at any scope.
   */
  async getIdentity(cwd: string): Promise<{ name: string; email: string }> {
    let name = '';
    let email = '';
    try {
      name = await this.runGit(['config', '--get', 'user.name'], cwd);
    } catch {
      // Not set — leave empty
    }
    try {
      email = await this.runGit(['config', '--get', 'user.email'], cwd);
    } catch {
      // Not set — leave empty
    }
    return { name, email };
  }

  /**
   * Write user.name and user.email. `scope: 'global'` writes to the user's
   * ~/.gitconfig; `scope: 'local'` writes to .git/config for this repo.
   */
  async setIdentity(
    cwd: string,
    name: string,
    email: string,
    scope: 'local' | 'global' = 'local',
  ): Promise<void> {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName) throw new Error('Name must not be empty');
    if (!trimmedEmail) throw new Error('Email must not be empty');

    const scopeFlag = scope === 'global' ? '--global' : '--local';
    await this.runGit(['config', scopeFlag, 'user.name', trimmedName], cwd);
    await this.runGit(['config', scopeFlag, 'user.email', trimmedEmail], cwd);
    logger.info('Git identity set', { cwd, scope, name: trimmedName, email: trimmedEmail });
  }

  /**
   * Pull from remote, asking for a login when it needs one.
   * @param expectedBranch If set, abort unless HEAD currently points at this branch.
   */
  async pull(cwd: string, expectedBranch?: string): Promise<GitRemoteResult> {
    const result = await this.runRemote(['pull'], cwd, expectedBranch);
    logger.info('Git pull', { cwd, ok: result.ok, ...(!result.ok && result.auth ? { auth: result.auth.reason } : {}) });
    return result;
  }

  /**
   * Push to remote, asking for a login when it needs one.
   * @param expectedBranch If set, abort unless HEAD currently points at this branch.
   */
  async push(cwd: string, expectedBranch?: string): Promise<GitRemoteResult> {
    const result = await this.runRemote(['push'], cwd, expectedBranch);
    logger.info('Git push', { cwd, ok: result.ok, ...(!result.ok && result.auth ? { auth: result.auth.reason } : {}) });
    return result;
  }

  /**
   * List local and remote-tracking branches.
   * Remote symbolic refs (e.g. origin/HEAD) are filtered out.
   */
  async listBranches(cwd: string): Promise<GitBranch[]> {
    const output = await this.runGit(
      [
        'for-each-ref',
        '--format=%(refname)%09%(refname:short)%09%(upstream:short)',
        'refs/heads',
        'refs/remotes',
      ],
      cwd
    );
    if (!output) return [];

    const branches: GitBranch[] = [];
    for (const line of output.split('\n')) {
      const [refname, shortName, upstream] = line.split('\t');
      if (!refname || !shortName) continue;
      const isRemote = refname.startsWith('refs/remotes/');
      // Skip remote symbolic refs like "origin/HEAD" — they point at another ref.
      if (isRemote && shortName.endsWith('/HEAD')) continue;
      branches.push({ name: shortName, isRemote, upstream: upstream ?? '' });
    }
    return branches;
  }

  /**
   * Validate a branch name client-side before invoking git. We intentionally
   * stay conservative — git's own validation (`check-ref-format`) is stricter
   * and will reject anything we miss. This catches the obvious cases up front
   * so the error toast is meaningful instead of a cryptic git message.
   */
  private validateBranchName(name: string): void {
    if (!name || !name.trim()) {
      throw new Error('Branch name must not be empty');
    }
    // Reject whitespace, control chars, and the characters git always rejects.
    if (/[\s~^:?*[\\]/.test(name) || name.includes('..') || name.includes('@{')) {
      throw new Error(`Invalid branch name: ${name}`);
    }
    if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.lock')) {
      throw new Error(`Invalid branch name: ${name}`);
    }
  }

  /**
   * Check out an existing branch. If given a remote-tracking ref like
   * "origin/foo", git's DWIM rules create a local "foo" tracking it.
   * Throws if the working tree has conflicting changes.
   */
  async checkoutBranch(cwd: string, branchName: string): Promise<string> {
    this.validateBranchName(branchName.replace(/^[^/]+\//, '')); // validate the local-name portion
    // Strip the remote prefix so git's DWIM creates/updates the local branch
    // instead of detaching HEAD on the remote ref.
    const target = branchName.includes('/') && (await this.isRemoteRef(cwd, branchName))
      ? branchName.substring(branchName.indexOf('/') + 1)
      : branchName;
    const output = await this.runGit(['checkout', target], cwd);
    logger.info('Git checkout', { cwd, branch: target });
    return output;
  }

  /**
   * Create a branch from HEAD. If checkout is true (default), switches to it.
   */
  async createBranch(cwd: string, branchName: string, checkout = true): Promise<string> {
    this.validateBranchName(branchName);
    const args = checkout ? ['checkout', '-b', branchName] : ['branch', branchName];
    const output = await this.runGit(args, cwd);
    logger.info('Git create branch', { cwd, branch: branchName, checkout });
    return output;
  }

  /**
   * Check whether the given name resolves to a remote-tracking ref.
   * Used to disambiguate "origin/foo" (remote ref → DWIM to local) from
   * a local branch whose name happens to contain "/" (e.g. "feature/foo").
   */
  private async isRemoteRef(cwd: string, name: string): Promise<boolean> {
    try {
      await this.runGit(['rev-parse', '--verify', `refs/remotes/${name}`], cwd);
      return true;
    } catch {
      return false;
    }
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

    // Periodic background fetch so collaborative repos pick up remote pushes
    // without the user having to switch dirs or hit Pull. The fetch is scoped
    // to whichever directory is currently watched, so switching conversations
    // automatically retargets and there's never more than one running.
    // The .git/FETCH_HEAD watcher above turns each fetch into a status refresh
    // automatically when ahead/behind actually changed.
    this.remoteFetchInterval = setInterval(() => {
      if (!this.watchedDir) return;
      this.fetch(this.watchedDir).catch(() => {
        // Non-critical: offline, no remote, auth missing, etc.
      });
    }, MAIN_CONSTANTS.GIT.REMOTE_FETCH_INTERVAL_MS);
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

    if (this.remoteFetchInterval) {
      clearInterval(this.remoteFetchInterval);
      this.remoteFetchInterval = null;
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
