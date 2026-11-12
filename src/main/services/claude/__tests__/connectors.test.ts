/**
 * Reading the tools every project has — claude.ai connectors and user-wide
 * servers — from a CLI session.
 *
 * The session is the SDK's Query, the process boundary, so it is the only
 * thing faked; its answers are shaped as CLI 2.1.280 gave them.
 */

import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { CONNECTORS_SETTLE_MS, isClaudeAiPage, readGlobalToolStatuses } from '../connectors';

function session(reads: unknown[][]): Query {
  let read = 0;
  return { mcpServerStatus: vi.fn(async () => reads[Math.min(read++, reads.length - 1)]) } as unknown as Query;
}

describe('readGlobalToolStatuses', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops waiting for an account with no connectors, and says there are none', async () => {
    vi.useFakeTimers();
    const reading = readGlobalToolStatuses(session([[]]), true);
    await vi.advanceTimersByTimeAsync(CONNECTORS_SETTLE_MS + 1000);

    expect(await reading).toEqual([]);
  });

  it('knows a connector, and a user-wide server, by its scope on a CLI that predates `source`', async () => {
    const list = await readGlobalToolStatuses(session([[
      { name: 'claude.ai Gmail', status: 'needs-auth', scope: 'claudeai' },
      { name: 'notes', status: 'connected', scope: 'user' },
      { name: 'gsc', status: 'connected', scope: 'project' },
      { name: 'scratch', status: 'connected', scope: 'local' },
    ]]), true);

    expect(list).toEqual([
      { name: 'claude.ai Gmail', kind: 'connector', status: 'needs-auth' },
      { name: 'notes', kind: 'user', status: 'connected' },
    ]);
  });

  it('waits for a user-wide server still connecting, and for no connector without a claude.ai sign-in', async () => {
    const reads = session([
      [{ name: 'notes', status: 'pending', source: 'user' }],
      [{ name: 'notes', status: 'connected', source: 'user' }],
    ]);

    expect(await readGlobalToolStatuses(reads, false)).toEqual([{ name: 'notes', kind: 'user', status: 'connected' }]);
    expect(reads.mcpServerStatus).toHaveBeenCalledTimes(2);
  });

  it('waits for the connectors with a claude.ai sign-in, though the rest are settled', async () => {
    const reads = session([
      [{ name: 'notes', status: 'connected', source: 'user' }],
      [{ name: 'notes', status: 'connected', source: 'user' }, { name: 'claude.ai Gmail', status: 'needs-auth', source: 'claudeai' }],
    ]);

    expect(await readGlobalToolStatuses(reads, true)).toEqual([
      { name: 'notes', kind: 'user', status: 'connected' },
      { name: 'claude.ai Gmail', kind: 'connector', status: 'needs-auth' },
    ]);
  });
});

describe('isClaudeAiPage', () => {
  it("accepts claude.ai's own https pages only", () => {
    expect(isClaudeAiPage('https://claude.ai/api/organizations/o/mcp/start-auth/s')).toBe(true);
    expect(isClaudeAiPage('http://claude.ai/api/organizations/o/mcp/start-auth/s')).toBe(false);
    expect(isClaudeAiPage('https://claude.ai.example.com/start')).toBe(false);
    expect(isClaudeAiPage('https://evil.example/?claude.ai')).toBe(false);
    expect(isClaudeAiPage('not a url')).toBe(false);
  });
});
