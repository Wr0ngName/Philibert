/**
 * Whether Claude has replied in a discussion, read from its messages file on
 * a real disk: what tells a discussion that lost its session from one just
 * started (Conversation.sessionGone).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { ChatMessage } from '../../../shared/types';
import { type ConversationDetails, hasClaudeReply } from '../conversation-files';
import { recordLine } from '../conversation-log';

let dir: string;
const details: ConversationDetails = { id: 'c', title: 't', workingDirectory: '/p', createdAt: 1, updatedAt: 1 };
const detailsFile = () => path.join(dir, 'c.json');

function message(role: ChatMessage['role'], content: string, id = `${role}-${content.length}`): ChatMessage {
  return { id, role, content, timestamp: 1 };
}

function messagesFile(...lines: string[]): void {
  fs.writeFileSync(path.join(dir, 'c.messages.jsonl'), `${lines.join('\n')}\n`);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-scan-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('hasClaudeReply', () => {
  it('finds a reply', async () => {
    messagesFile(recordLine({ put: message('user', 'q') }), recordLine({ put: message('assistant', 'a') }));
    expect(await hasClaudeReply(detailsFile(), details)).toBe(true);
  });

  it('finds none in a discussion only asked in', async () => {
    messagesFile(recordLine({ put: message('user', 'q') }), recordLine({ put: message('user', 'again', 'u2') }));
    expect(await hasClaudeReply(detailsFile(), details)).toBe(false);
  });

  it('finds none with no messages file at all', async () => {
    expect(await hasClaudeReply(detailsFile(), details)).toBe(false);
  });

  it('is not taken in by the word in what was said', async () => {
    messagesFile(recordLine({ put: message('user', '{"role":"assistant"}') }));
    expect(await hasClaudeReply(detailsFile(), details)).toBe(false);
  });

  it('finds a reply far past the first piece read, behind a long line cut across pieces', async () => {
    // Longer than a piece, with characters of several bytes across the cuts.
    const long = 'é€😀'.repeat(40_000);
    messagesFile(recordLine({ put: message('user', long) }), recordLine({ put: message('assistant', 'a') }));
    expect(await hasClaudeReply(detailsFile(), details)).toBe(true);
  });

  it('finds a reply whose line is cut across two pieces', async () => {
    // The first line ends 10 bytes before the first piece does: the reply's
    // line starts in the first piece and ends in the second.
    const PIECE = 64 * 1024;
    const empty = recordLine({ put: message('user', '', 'u') }).length;
    const first = recordLine({ put: message('user', 'a'.repeat(PIECE - 10 - 1 - empty), 'u') });
    expect(Buffer.byteLength(`${first}\n`)).toBe(PIECE - 10);
    messagesFile(first, recordLine({ put: message('assistant', 'the answer', 'r') }));

    expect(await hasClaudeReply(detailsFile(), details)).toBe(true);
  });

  it('finds a reply on a last line with no line end', async () => {
    fs.writeFileSync(
      path.join(dir, 'c.messages.jsonl'),
      `${recordLine({ put: message('user', 'q') })}\n${recordLine({ put: message('assistant', 'a') })}`,
    );
    expect(await hasClaudeReply(detailsFile(), details)).toBe(true);
  });

  it('reads the messages of a discussion still in the one-file layout', async () => {
    expect(await hasClaudeReply(detailsFile(), { ...details, messages: [message('assistant', 'a')] } as never)).toBe(true);
    expect(await hasClaudeReply(detailsFile(), { ...details, messages: [message('user', 'q')] } as never)).toBe(false);
  });
});
