/**
 * Watches the transcript of the Claude Code session the open discussion
 * continues, so that the moment Claude Code deletes it — its clean-up after
 * `cleanupPeriodDays`, run by any Claude Code that starts, a terminal one
 * included — the discussion is archived for good (Conversation.sessionGone)
 * and its input goes, rather than when the user next tries to send.
 *
 * Only the open discussion: it is the one with an input on screen. Another
 * is found gone when it is listed or opened (ConversationService), or when
 * a prompt is about to resume it (useClaudeChat).
 *
 * A transcript not on disk when the watch starts is not taken as gone: a
 * new discussion's is written by its first turn, after Claude Code has
 * already given its session id — the renderer watches again once a turn has
 * ended. One already gone was said so when the discussion was opened.
 */

import fs from 'node:fs';

import logger from '../../utils/logger';

import { cliConfigDir } from './cliCredentials';
import { findSessionTranscript } from './transcript-files';

interface Watched {
  conversationId: string;
  sessionId: string;
  file: string;
  watcher: fs.FSWatcher;
}

export class SessionTranscriptWatch {
  private watched: Watched | null = null;

  constructor(
    private readonly onGone: (conversationId: string) => void,
    private readonly configDir: () => string = cliConfigDir,
  ) {}

  /** Watch this discussion's session instead of any other; null for none. */
  watch(conversationId: string, sessionId: string | null): void {
    const current = this.watched;
    if (current && current.conversationId === conversationId && current.sessionId === sessionId) return;
    this.stop();
    if (!sessionId) return;

    const file = findSessionTranscript(sessionId, this.configDir());
    if (!file) {
      logger.debug('Session transcript not on disk yet — not watched', { conversationId });
      return;
    }
    try {
      const watcher = fs.watch(file, () => this.check());
      // A watch that fails leaves the check before each send to find it.
      watcher.on('error', (error) => {
        logger.warn('Watching a session transcript failed', { conversationId, error });
        this.stop();
      });
      watcher.unref();
      this.watched = { conversationId, sessionId, file, watcher };
    } catch (error) {
      logger.warn('Could not watch a session transcript', { conversationId, error });
    }
  }

  stop(): void {
    this.watched?.watcher.close();
    this.watched = null;
  }

  /** A change to the file: gone when it is no longer there. */
  private check(): void {
    const current = this.watched;
    if (!current || fs.existsSync(current.file)) return;
    logger.warn('Session transcript deleted — the discussion is archived', { conversationId: current.conversationId });
    this.stop();
    this.onGone(current.conversationId);
  }
}
