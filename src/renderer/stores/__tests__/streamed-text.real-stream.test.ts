/**
 * What a real reply looks like on screen, from real CLI output.
 *
 * The app used to insert '\n\n' whenever a text content block started, which
 * broke replies apart at arbitrary points. Removing it outright was wrong —
 * and I only found that out by capturing what the CLI actually sends, which
 * is what these fixtures are:
 *
 *  - `stream-three-paragraphs.jsonl`: a plain three-paragraph answer. ONE text
 *    content block, 55 deltas, and the paragraph breaks are inside the deltas.
 *    Nothing needs to be inserted for this one, and inserting anything is how
 *    the reported breaks appeared.
 *  - `stream-text-tools-text.jsonl`: a turn that talks, runs a tool, talks,
 *    runs another, talks. THREE text content blocks, none of them starting
 *    with a newline, so concatenating them verbatim gives
 *    "I'm about to check.It printed "hi"." — the run-together this app had to
 *    fix in the first place.
 *
 * Both were produced by running the bundled CLI (2.1.280) with
 * --output-format stream-json --include-partial-messages, and are replayed
 * here through the real SDKMessageHandler into the real chat store, wired the
 * way useClaudeChat wires them. So this asserts on the text a user would read,
 * not on an intermediate call.
 */

import fs from 'node:fs';
import path from 'node:path';

import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ToolCaptureData } from '@shared/types';

vi.mock('../../../main/utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogLevel: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SDKMessageHandler } from '../../../main/services/claude/SDKMessageHandler';
import { useChatStore } from '../chat';

const CONV = 'conv-real-stream';

function loadFixture(name: string): unknown[] {
  const file = path.join(__dirname, '..', '..', '..', 'main', 'services', 'claude', '__tests__', 'fixtures', name);
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as unknown);
}

/**
 * Replay a captured stream the way the app does: the real handler turns SDK
 * messages into the same callbacks ClaudeCodeService forwards over IPC, and
 * each one is applied to the real store exactly as useClaudeChat applies it.
 */
async function replay(name: string): Promise<ReturnType<typeof useChatStore>> {
  const chat = useChatStore();
  chat.setCurrentConversation(CONV);

  const handler = new SDKMessageHandler({
    onChunk: (chunk: string) => chat.appendChunk(CONV, chunk),
    onToolUseCapture: (capture: ToolCaptureData) => chat.addAutoToolUseMessage(CONV, capture),
    // `images` is dropped: the handler emits image BYTES, and what reaches
    // the renderer is references to bytes already stored — a conversion
    // ClaudeCodeService does, and which this file, about text streaming,
    // stands in for only as far as the text.
    onToolResult: ({ images: _images, ...result }) =>
      chat.updateToolUseResult(CONV, { ...result, outputFile: '' }),
    onSlashCommands: () => {},
    onTaskNotification: () => {},
    onUsageUpdate: () => {},
    onSystemNote: () => {},
  });

  for (const message of loadFixture(name)) {
    await handler.handleMessage(message as never);
  }
  chat.finishStreaming(CONV);
  return chat;
}

/** The text of each message on screen, tool indicators left out. */
function visibleText(chat: ReturnType<typeof useChatStore>): string[] {
  return chat.messages.filter((m) => !m.toolUse && m.content !== '').map((m) => m.content);
}

describe('a real reply on screen', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('keeps a three-paragraph answer as one message, with its own blank lines', async () => {
    const chat = await replay('stream-three-paragraphs.jsonl');

    const texts = visibleText(chat);
    expect(texts).toHaveLength(1);
    // The model's paragraph breaks, and no others.
    expect(texts[0].split('\n\n')).toHaveLength(3);
    expect(texts[0]).toMatch(/^Sunlight looks white/);
  });

  it('never breaks a line inside a word', async () => {
    // The report: "it puts line breaks everywhere, even in the middle of
    // words". A break between two letters of a word can only come from
    // something this app inserted.
    for (const fixture of ['stream-three-paragraphs.jsonl', 'stream-text-tools-text.jsonl']) {
      const chat = await replay(fixture);
      for (const text of visibleText(chat)) {
        expect(text, `${fixture}: broke a word`).not.toMatch(/[a-z]\n+[a-z]/);
      }
      setActivePinia(createPinia());
    }
  });

  it('keeps what it said before and after a tool apart', async () => {
    // The reason a separator was added at all: these three pieces arrive as
    // three text blocks, none starting with a newline, so without separation
    // they read as "I'm about to check.It printed "hi"."
    const chat = await replay('stream-text-tools-text.jsonl');

    const texts = visibleText(chat);
    expect(texts.length).toBeGreaterThan(1);
    const all = texts.join(' ');
    expect(all).not.toMatch(/check\.It printed/);
    expect(all).toMatch(/I'm about to check\./);
    expect(all).toMatch(/It printed "hi"\./);
  });

  it('puts the tool calls between what was said, in order', async () => {
    const chat = await replay('stream-text-tools-text.jsonl');

    const shape = chat.messages
      .filter((m) => m.toolUse || m.content !== '')
      .map((m) => (m.toolUse ? `tool:${m.toolUse.toolName}` : 'text'));

    expect(shape).toEqual(['text', 'tool:Bash', 'text', 'tool:Bash', 'text']);
  });
});
