/**
 * Watches Claude Code's session transcripts (`<config>/projects/<project>/
 * <sessionId>.jsonl`) for being deleted — its clean-up after
 * `cleanupPeriodDays`, run by any Claude Code that starts, a terminal one
 * included — so that every discussion continuing a deleted session is
 * archived for good at once (Conversation.sessionGone): the one on screen
 * loses its input, and the others' rows leave the active list, instead of
 * either waiting for the user to send or for the list to be read again.
 *
 * One watcher on the projects folder, for project folders coming and going,
 * and one on each project folder. A change in a folder lists it again and
 * compares it with what it held: what is no longer there was deleted. That
 * asks nothing of an event but which folder it came from — what fs.watch
 * says of the file itself differs between systems, and is sometimes nothing.
 * Listings after a change are put off a little: a session being written to
 * changes its folder at each message.
 */

import fs from 'node:fs';
import path from 'node:path';

import logger from '../../utils/logger';

import { cliConfigDir } from './cliCredentials';

/** How long a folder's listing waits after a change, for the changes after it. */
export const SESSIONS_RESCAN_DELAY_MS = 200;

const TRANSCRIPT_SUFFIX = '.jsonl';

interface WatchedFolder {
  watcher: fs.FSWatcher | null;
  sessions: Set<string>;
  rescan: ReturnType<typeof setTimeout> | null;
}

export class ClaudeSessionsWatch {
  private projectsWatcher: fs.FSWatcher | null = null;
  private projectsRescan: ReturnType<typeof setTimeout> | null = null;
  private readonly folders = new Map<string, WatchedFolder>();

  constructor(
    private readonly onDeleted: (sessionIds: string[]) => void,
    private readonly configDir: () => string = cliConfigDir,
  ) {}

  private get projectsDir(): string {
    return path.join(this.configDir(), 'projects');
  }

  /**
   * Start watching, if not already. False when there is no projects folder
   * yet — Claude Code has never run here: called again later, it starts then.
   */
  start(): boolean {
    if (this.projectsWatcher) return true;
    try {
      this.projectsWatcher = fs.watch(this.projectsDir, () => this.scheduleProjectsRescan());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn("Could not watch Claude Code's sessions", { error });
      }
      return false;
    }
    this.projectsWatcher.on('error', (error) => {
      logger.warn("Watching Claude Code's sessions failed", { error });
      this.stop();
    });
    this.projectsWatcher.unref();
    this.rescanProjects();
    logger.info("Watching Claude Code's sessions for being deleted", { folders: this.folders.size });
    return true;
  }

  stop(): void {
    this.projectsWatcher?.close();
    this.projectsWatcher = null;
    if (this.projectsRescan) clearTimeout(this.projectsRescan);
    this.projectsRescan = null;
    for (const folder of this.folders.values()) this.closeFolder(folder);
    this.folders.clear();
  }

  private scheduleProjectsRescan(): void {
    this.projectsRescan ??= setTimeout(() => {
      this.projectsRescan = null;
      this.rescanProjects();
    }, SESSIONS_RESCAN_DELAY_MS);
    this.projectsRescan.unref?.();
  }

  /** Project folders come and go: watch the new ones; a removed one's sessions were deleted with it. */
  private rescanProjects(): void {
    if (!this.projectsWatcher) return;
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(this.projectsDir, { withFileTypes: true });
    } catch (error) {
      logger.warn("Could not list Claude Code's project folders", { error });
      return;
    }
    const present = new Set(names.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    const deleted: string[] = [];
    for (const [name, folder] of this.folders) {
      if (present.has(name)) continue;
      deleted.push(...folder.sessions);
      this.closeFolder(folder);
      this.folders.delete(name);
    }
    for (const name of present) {
      if (!this.folders.has(name)) this.watchFolder(name);
    }
    this.report(deleted);
  }

  private watchFolder(name: string): void {
    const folder: WatchedFolder = { watcher: null, sessions: new Set(), rescan: null };
    this.folders.set(name, folder);
    try {
      folder.watcher = fs.watch(path.join(this.projectsDir, name), () => this.scheduleFolderRescan(name));
      // A folder removed under its watcher, on some systems: the projects
      // folder's own watcher sees it go, and reports its sessions.
      folder.watcher.on('error', () => {
        folder.watcher?.close();
        folder.watcher = null;
        this.scheduleProjectsRescan();
      });
      folder.watcher.unref();
    } catch (error) {
      logger.warn("Could not watch a Claude Code project folder", { name, error });
    }
    folder.sessions = this.sessionsIn(name) ?? new Set();
  }

  private scheduleFolderRescan(name: string): void {
    const folder = this.folders.get(name);
    if (!folder) return;
    folder.rescan ??= setTimeout(() => {
      folder.rescan = null;
      this.rescanFolder(name);
    }, SESSIONS_RESCAN_DELAY_MS);
    folder.rescan.unref?.();
  }

  private rescanFolder(name: string): void {
    const folder = this.folders.get(name);
    if (!folder) return;
    const now = this.sessionsIn(name);
    // The folder itself is gone: the projects folder's watcher reports it.
    if (!now) {
      this.scheduleProjectsRescan();
      return;
    }
    const deleted = [...folder.sessions].filter((sessionId) => !now.has(sessionId));
    folder.sessions = now;
    this.report(deleted);
  }

  /** The sessions with a transcript in a project folder; null when the folder is gone. */
  private sessionsIn(name: string): Set<string> | null {
    try {
      return new Set(
        fs.readdirSync(path.join(this.projectsDir, name))
          .filter((file) => file.endsWith(TRANSCRIPT_SUFFIX))
          .map((file) => file.slice(0, -TRANSCRIPT_SUFFIX.length)),
      );
    } catch {
      return null;
    }
  }

  private closeFolder(folder: WatchedFolder): void {
    folder.watcher?.close();
    folder.watcher = null;
    if (folder.rescan) clearTimeout(folder.rescan);
    folder.rescan = null;
  }

  private report(deleted: string[]): void {
    if (deleted.length === 0) return;
    logger.info('Claude Code session transcripts deleted', { count: deleted.length });
    this.onDeleted(deleted);
  }
}
