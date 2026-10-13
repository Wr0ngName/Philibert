/**
 * Reading a background task's output file.
 *
 * The lines used here were taken from a real transcript the CLI wrote for a
 * real background agent, not invented: a `user` entry whose content is a
 * plain string, an `assistant` entry whose content is an array of blocks, and
 * `attachment` entries that are machinery rather than activity — there were
 * eleven of those in a transcript whose entire result was the word PING.
 */

import { describe, it, expect } from 'vitest';

import { parseTaskOutput } from '../task-output';

/** Verbatim shapes from the captured transcript, trimmed of noise fields. */
const REAL_USER_LINE = JSON.stringify({
  parentUuid: null,
  isSidechain: true,
  agentId: 'a0df431f0ec89504a',
  type: 'user',
  message: { role: 'user', content: 'Reply with the single word PING and nothing else.' },
  uuid: '205f7075-6efb-459a-b201-e5f2c8c78c6b',
  timestamp: '2026-10-13T16:17:19.500Z',
  cwd: '/tmp',
});

const REAL_ASSISTANT_LINE = JSON.stringify({
  type: 'assistant',
  agentId: 'a0df431f0ec89504a',
  message: { role: 'assistant', content: [{ type: 'text', text: 'PING' }] },
  uuid: 'b1',
  timestamp: '2026-10-13T16:17:21.000Z',
});

const REAL_ATTACHMENT_LINE = JSON.stringify({
  type: 'attachment',
  attachment: { type: 'tools', addedNames: ['Read'] },
  rendered: [{ content: '<system-reminder>The following tools just became available…' }],
  uuid: 'c1',
});

describe('parseTaskOutput', () => {
  it('reports nothing for an empty file', () => {
    expect(parseTaskOutput('')).toEqual({ kind: 'empty' });
    expect(parseTaskOutput('   \n ')).toEqual({ kind: 'empty' });
    expect(parseTaskOutput(null)).toEqual({ kind: 'empty' });
  });

  it('shows a shell task s output as the text it is', () => {
    // Measured: a background `echo` wrote exactly this, 17 bytes.
    expect(parseTaskOutput('hello-from-shell\n')).toEqual({
      kind: 'text',
      text: 'hello-from-shell\n',
    });
  });

  it('shows command output that happens to be JSON as text', () => {
    // A command printing a JSON document is not a transcript, and must not be
    // taken apart as one. The discriminator is a per-line object with a
    // `type`, which this does not have.
    const raw = '{"ok":true,"items":[1,2,3]}';
    expect(parseTaskOutput(raw)).toEqual({ kind: 'text', text: raw });
  });

  it('reads an agent transcript as a sequence of steps', () => {
    const result = parseTaskOutput(
      [REAL_USER_LINE, REAL_ATTACHMENT_LINE, REAL_ASSISTANT_LINE].join('\n'),
    );

    expect(result.kind).toBe('transcript');
    if (result.kind !== 'transcript') return;
    expect(result.steps).toEqual([
      { role: 'user', text: 'Reply with the single word PING and nothing else.' },
      { role: 'assistant', text: 'PING' },
    ]);
  });

  it('counts the machinery it leaves out rather than hiding it', () => {
    // Eleven attachment entries in a transcript whose result was one word.
    // Silently discarding them is how the modal came to show nothing useful.
    const result = parseTaskOutput(
      [REAL_USER_LINE, ...Array(11).fill(REAL_ATTACHMENT_LINE), REAL_ASSISTANT_LINE].join('\n'),
    );

    expect(result.kind).toBe('transcript');
    if (result.kind !== 'transcript') return;
    expect(result.skipped).toBe(11);
  });

  it('renders a tool call as the tool and what it was given', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls -la', description: 'list' } },
        ],
      },
    });

    const result = parseTaskOutput([REAL_USER_LINE, line].join('\n'));
    expect(result.kind).toBe('transcript');
    if (result.kind !== 'transcript') return;
    expect(result.steps[1]).toEqual({ role: 'assistant', text: 'Let me look.' });
    expect(result.steps[2]).toEqual({
      role: 'assistant',
      toolName: 'Bash',
      toolInput: 'ls -la',
    });
  });

  it('names a tool call even when its input has nothing worth showing', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TodoWrite', input: {} }] },
    });

    const result = parseTaskOutput([REAL_USER_LINE, line].join('\n'));
    if (result.kind !== 'transcript') throw new Error('expected a transcript');
    expect(result.steps[1]).toEqual({ role: 'assistant', toolName: 'TodoWrite', toolInput: undefined });
  });

  it('survives a truncated last line', () => {
    // A file still being written, or cut short. The rest must still render.
    const result = parseTaskOutput([REAL_USER_LINE, '{"type":"assist'].join('\n'));

    expect(result.kind).toBe('transcript');
    if (result.kind !== 'transcript') return;
    expect(result.steps).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });

  it('leaves out an entry type it does not know, and counts it', () => {
    const line = JSON.stringify({ type: 'something-new-from-the-cli', payload: 1 });
    const result = parseTaskOutput([REAL_USER_LINE, line].join('\n'));

    if (result.kind !== 'transcript') throw new Error('expected a transcript');
    expect(result.steps).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });
});
