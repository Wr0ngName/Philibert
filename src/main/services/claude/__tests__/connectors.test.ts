/**
 * Reading the claude.ai connectors from a CLI session.
 *
 * The session is the SDK's Query, the process boundary, so it is the only
 * thing faked; its answers are shaped as CLI 2.1.280 gave them.
 */

import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { CONNECTORS_SETTLE_MS, isClaudeAiPage, readClaudeAiConnectors } from '../connectors';

function session(reads: unknown[][]): Query {
  let read = 0;
  return { mcpServerStatus: vi.fn(async () => reads[Math.min(read++, reads.length - 1)]) } as unknown as Query;
}

describe('readClaudeAiConnectors', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops waiting for an account with no connectors, and says there are none', async () => {
    vi.useFakeTimers();
    const reading = readClaudeAiConnectors(session([[]]));
    await vi.advanceTimersByTimeAsync(CONNECTORS_SETTLE_MS + 1000);

    expect(await reading).toEqual([]);
  });

  it('knows a connector by its scope on a CLI that predates `source`', async () => {
    const list = await readClaudeAiConnectors(session([[
      { name: 'claude.ai Gmail', status: 'needs-auth', scope: 'claudeai' },
      { name: 'gsc', status: 'connected', scope: 'project' },
    ]]));

    expect(list).toEqual([{ name: 'claude.ai Gmail', status: 'needs-auth' }]);
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
