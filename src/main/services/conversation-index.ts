/**
 * The discussions list's entries, kept so that listing does not read every
 * conversation file.
 *
 * A conversation is one JSON document holding its whole history, so the list
 * used to parse every file in full on each load — a cost that only grew. Here
 * each file's entry is kept with the file's modification time and size: a
 * refresh lists the folder and looks at each file's stat, and parses only a
 * file that is new or has changed since. The entries are saved beside the
 * folder, so the next start parses nothing that has not changed.
 *
 * The saved index is only ever a cache. A missing, unreadable or stale one is
 * rebuilt from the files, which stay the one source of truth; a change made
 * while the app was closed is caught by its stat.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { summaryOf } from '../../shared/conversation-list';
import type { Conversation, ConversationSummary } from '../../shared/types';
import logger from '../utils/logger';

interface IndexEntry {
  mtimeMs: number;
  size: number;
  summary: ConversationSummary;
}

interface SavedIndex {
  version: typeof INDEX_VERSION;
  entries: Record<string, IndexEntry>;
}

/**
 * Bumped when an entry's shape or content changes, so an older index is
 * rebuilt. 2: titles listed whole, where 1 kept them as saved, cut at 50.
 */
const INDEX_VERSION = 2;
/** Files looked at together during a refresh. */
const STAT_BATCH = 64;
/** Saving waits for writes to settle: a turn saves its conversation often. */
export const INDEX_SAVE_DELAY_MS = 2000;

export class ConversationIndex {
  /** By file name, which is what the folder lists. */
  private entries = new Map<string, IndexEntry>();
  private loaded = false;
  private refreshing: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly dir: string,
    private readonly indexFile: string,
  ) {}

  /** Bring the entries in line with the folder; see the top of this file. */
  refresh(): Promise<void> {
    // One at a time: a second caller waits for the refresh under way.
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Whether the entries were read at least once. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  summaries(): ConversationSummary[] {
    return [...this.entries.values()].map((entry) => entry.summary);
  }

  summary(id: string): ConversationSummary | null {
    for (const entry of this.entries.values()) {
      if (entry.summary.id === id) return entry.summary;
    }
    return null;
  }

  /** Record what was just written to a file, as its stat now stands. */
  async noteWritten(fileName: string, conversation: Conversation): Promise<void> {
    try {
      const stat = await fs.promises.stat(path.join(this.dir, fileName));
      this.entries.set(fileName, { mtimeMs: stat.mtimeMs, size: stat.size, summary: summaryOf(conversation) });
      this.scheduleSave();
    } catch (error) {
      // The next refresh reads the file again.
      this.entries.delete(fileName);
      logger.warn('Could not record a written conversation in the index', { fileName, error });
    }
  }

  noteDeleted(fileName: string): void {
    if (this.entries.delete(fileName)) this.scheduleSave();
  }

  /** Save now rather than after the delay; for quitting. */
  async flush(): Promise<void> {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.save();
  }

  private async doRefresh(): Promise<void> {
    if (!this.loaded) await this.load();

    let names: string[];
    try {
      names = (await fs.promises.readdir(this.dir)).filter((name) => name.endsWith('.json'));
    } catch (error) {
      logger.error('Failed to list the conversations folder', { dir: this.dir, error });
      this.loaded = true;
      return;
    }

    let changed = false;
    const present = new Set(names);
    for (const name of [...this.entries.keys()]) {
      if (!present.has(name)) {
        this.entries.delete(name);
        changed = true;
      }
    }

    let parsed = 0;
    for (let start = 0; start < names.length; start += STAT_BATCH) {
      const batch = names.slice(start, start + STAT_BATCH);
      const results = await Promise.all(batch.map((name) => this.refreshFile(name)));
      for (const result of results) {
        if (result !== 'unchanged') changed = true;
        if (result === 'parsed') parsed += 1;
      }
    }

    this.loaded = true;
    if (changed) {
      logger.info('Conversation index refreshed', { files: names.length, parsed });
      this.scheduleSave();
    }
  }

  private async refreshFile(name: string): Promise<'unchanged' | 'parsed' | 'dropped'> {
    const file = path.join(this.dir, name);
    try {
      const stat = await fs.promises.stat(file);
      const known = this.entries.get(name);
      if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return 'unchanged';
      const conversation = JSON.parse(await fs.promises.readFile(file, 'utf-8')) as Conversation;
      this.entries.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, summary: summaryOf(conversation) });
      return 'parsed';
    } catch (error) {
      // Left out, as the list always left out a file it could not parse.
      logger.warn('Failed to read a conversation for the list', { file: name, error });
      return this.entries.delete(name) ? 'dropped' : 'unchanged';
    }
  }

  private async load(): Promise<void> {
    try {
      const saved = JSON.parse(await fs.promises.readFile(this.indexFile, 'utf-8')) as SavedIndex;
      if (saved.version !== INDEX_VERSION || typeof saved.entries !== 'object' || saved.entries === null) return;
      for (const [name, entry] of Object.entries(saved.entries)) {
        if (
          typeof entry?.mtimeMs === 'number' &&
          typeof entry.size === 'number' &&
          typeof entry.summary?.id === 'string' &&
          typeof entry.summary.updatedAt === 'number'
        ) {
          this.entries.set(name, entry);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('Conversation index unreadable — rebuilding it from the files', { error });
      }
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, INDEX_SAVE_DELAY_MS);
    // Never what keeps the process alive; a save missed at exit only costs
    // re-reading the changed files at the next start.
    this.saveTimer.unref?.();
  }

  private async save(): Promise<void> {
    const saved: SavedIndex = { version: INDEX_VERSION, entries: Object.fromEntries(this.entries) };
    // Written beside and renamed over, so a crash mid-write leaves the old one.
    const temporary = `${this.indexFile}.tmp`;
    try {
      await fs.promises.writeFile(temporary, JSON.stringify(saved), 'utf-8');
      await fs.promises.rename(temporary, this.indexFile);
    } catch (error) {
      logger.warn('Failed to save the conversation index', { error });
    }
  }
}
