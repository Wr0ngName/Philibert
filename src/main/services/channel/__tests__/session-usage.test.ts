/**
 * Channel-mode cost accounting.
 *
 * Channel sessions run the CLI in a PTY so it bills against the subscription,
 * which means the SDK never sees the turn and never reports a cost. The only
 * signal is the CLI's session JSONL, which carries token counts and no cost
 * field at all — so this path prices the tokens itself, and these tests pin
 * the arithmetic against real JSONL shapes.
 *
 * Mocks only external boundaries (electron, logger, fs, node-pty, resource
 * paths); the usage parsing and pricing under test are the real ones.
 */

import * as fs from 'node:fs';

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test'), getName: vi.fn(() => 'test') },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((v: string) => Buffer.from(v)),
    decryptString: vi.fn((b: Buffer) => b.toString()),
  },
}));

vi.mock('electron-store', () => ({
  default: class {
    get() { return undefined; }
    set() {}
    delete() {}
    has() { return false; }
    clear() {}
    get store() { return {}; }
  },
}));

vi.mock('../../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../utils/resourcePaths', () => ({
  ClaudeCliPaths: { findBundledCli: vi.fn(() => '/usr/bin/claude') },
  ChannelPaths: { getChannelServerScript: vi.fn(() => '/tmp/channel-server.cjs') },
  getChannelSessionsDir: vi.fn(() => '/tmp/channel-sessions'),
  WindowsPaths: { toWslPath: vi.fn((p: string) => p) },
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 4242,
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

// ChannelSession imports `node:fs`, so that is the specifier to intercept.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, default: actual, readFileSync: vi.fn(() => '') };
});

import { parseSessionUsage } from '../ChannelSession';

/** An assistant entry in the shape the CLI actually writes. */
function assistantEntry(model: string, usage: Record<string, unknown>): string {
  return JSON.stringify({ type: 'assistant', message: { model, role: 'assistant', usage } });
}

function withJsonl(lines: string[]): void {
  vi.mocked(fs.readFileSync).mockReturnValue(lines.join('\n'));
}

beforeEach(() => {
  vi.mocked(fs.readFileSync).mockReset();
});

describe('parseSessionUsage', () => {
  it('prices each model at its own rate rather than one rate per family', () => {
    // Opus 4.7 and Opus 5 are the same family at the same time, and both
    // appear in real session files. Charging the family's oldest rate to both
    // is how this drifted to a ~3x overstatement.
    withJsonl([
      assistantEntry('claude-opus-5', { input_tokens: 1_000_000, output_tokens: 0 }),
      assistantEntry('claude-opus-4-1', { input_tokens: 1_000_000, output_tokens: 0 }),
    ]);

    const usage = parseSessionUsage('/tmp/session.jsonl');

    expect(usage.models['claude-opus-5'].costUsd).toBeCloseTo(5, 6);
    expect(usage.models['claude-opus-4-1'].costUsd).toBeCloseTo(15, 6);
    expect(usage.totals.costUsd).toBeCloseTo(20, 6);
  });

  it('bills 1-hour cache writes at 2x, not the 5-minute 1.25x', () => {
    // Real sessions are dominated by the 1h TTL — a live file showed 16,158
    // 1h tokens against 0 5m tokens on every entry — so this is the common
    // case, not an edge one.
    withJsonl([
      assistantEntry('claude-opus-5', {
        cache_creation_input_tokens: 1_000_000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
      }),
    ]);

    const usage = parseSessionUsage('/tmp/session.jsonl');

    expect(usage.models['claude-opus-5'].costUsd).toBeCloseTo(10, 6); // 5 * 2
    // The token count reported to the UI is still the undivided total.
    expect(usage.models['claude-opus-5'].cacheCreationInputTokens).toBe(1_000_000);
  });

  it('falls back to the 5-minute rate when no TTL breakdown is present', () => {
    withJsonl([
      assistantEntry('claude-opus-5', { cache_creation_input_tokens: 1_000_000 }),
    ]);

    expect(parseSessionUsage('/tmp/session.jsonl').models['claude-opus-5'].costUsd)
      .toBeCloseTo(6.25, 6); // 5 * 1.25
  });

  it('applies the Opus 5.5 cache-hit discount', () => {
    withJsonl([
      assistantEntry('claude-opus-5-5', { cache_read_input_tokens: 1_000_000 }),
    ]);

    // 0.05x of $4, not the standard 0.1x.
    expect(parseSessionUsage('/tmp/session.jsonl').models['claude-opus-5-5'].costUsd)
      .toBeCloseTo(0.2, 6);
  });

  it('reports synthetic entries without pricing them', () => {
    // The CLI stamps <synthetic> on messages it fabricates locally (quota
    // notices, "No response requested") and writes them next to real turns.
    // They used to be billed at Sonnet rates.
    withJsonl([
      assistantEntry('<synthetic>', { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
      assistantEntry('claude-opus-5', { input_tokens: 1_000_000, output_tokens: 0 }),
    ]);

    const usage = parseSessionUsage('/tmp/session.jsonl');

    expect(usage.models['<synthetic>'].inputTokens).toBe(1_000_000);
    expect(usage.models['<synthetic>'].costUsd).toBe(0);
    expect(usage.totals.costUsd).toBeCloseTo(5, 6);
  });

  it('accumulates repeated entries for the same model', () => {
    withJsonl([
      assistantEntry('claude-opus-5', { input_tokens: 500_000, output_tokens: 1_000 }),
      assistantEntry('claude-opus-5', { input_tokens: 500_000, output_tokens: 1_000 }),
    ]);

    const usage = parseSessionUsage('/tmp/session.jsonl');

    expect(usage.models['claude-opus-5'].inputTokens).toBe(1_000_000);
    expect(usage.models['claude-opus-5'].outputTokens).toBe(2_000);
    expect(usage.totals.inputTokens).toBe(1_000_000);
  });

  it('skips blank lines, malformed JSON, and non-assistant entries', () => {
    withJsonl([
      '',
      '{not json',
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5' } }), // no usage
      assistantEntry('claude-opus-5', { input_tokens: 1_000_000 }),
    ]);

    const usage = parseSessionUsage('/tmp/session.jsonl');

    expect(Object.keys(usage.models)).toEqual(['claude-opus-5']);
    expect(usage.totals.costUsd).toBeCloseTo(5, 6);
  });

  it('returns empty totals for a file with no assistant entries', () => {
    withJsonl(['']);

    const usage = parseSessionUsage('/tmp/session.jsonl');

    expect(usage.models).toEqual({});
    expect(usage.totals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0,
    });
  });
});
