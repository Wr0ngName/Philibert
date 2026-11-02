/**
 * claude.ai connectors, read and acted on through a CLI session.
 *
 * Connectors are the MCP servers set up on the claude.ai account the CLI is
 * logged in with. The CLI fetches them by itself in every session, with no
 * configuration of ours: `mcpServerStatus()` lists them with `source`
 * 'claudeai' and a `claudeai-proxy` config. Measured on CLI 2.1.280, in a
 * session that runs no turn:
 *
 *   0.6s  []                                   — not fetched yet
 *   1.1s  Claude Docs pending, Gmail needs-auth, …
 *   2.6s  Claude Docs connected, Gmail needs-auth, …
 *
 * so a read waits for the list to settle rather than taking the first answer.
 *
 * Authorising one is done on claude.ai: for a claudeai-proxy server the CLI's
 * `mcp_authenticate` answers with a claude.ai page to open, and expects no
 * callback. Turning one off is per project — the CLI's `mcp_toggle` writes
 * `disabledMcpServers` in that project's entry of ~/.claude.json, as
 * `/mcp disable` does.
 */

import type { McpServerStatus, Query } from '@anthropic-ai/claude-agent-sdk';

import type { ClaudeAiConnector } from '../../../shared/types';

/** How long a read waits for the list to settle: listed, and none pending. */
export const CONNECTORS_SETTLE_MS = 8000;
/** How often it asks in the meantime. */
export const CONNECTORS_POLL_MS = 300;

/** Whether a server is one of the account's claude.ai connectors. */
function isClaudeAiConnector(server: McpServerStatus): boolean {
  // `source` is the field to key trust on; `scope` is what CLIs that predate
  // it report.
  return (server.source ?? server.scope) === 'claudeai';
}

function toClaudeAiConnector(server: McpServerStatus): ClaudeAiConnector {
  return {
    name: server.name,
    status: server.status,
    ...(server.error ? { error: server.error } : {}),
    ...(server.tools ? { toolCount: server.tools.length } : {}),
  };
}

/**
 * The connectors as the session sees them, once settled — or as they stand
 * when CONNECTORS_SETTLE_MS has passed, which is also how an account with no
 * connectors reads: an empty list.
 */
export async function readClaudeAiConnectors(session: Query): Promise<ClaudeAiConnector[]> {
  const deadline = Date.now() + CONNECTORS_SETTLE_MS;
  for (;;) {
    const connectors = (await session.mcpServerStatus()).filter(isClaudeAiConnector).map(toClaudeAiConnector);
    const settled = connectors.length > 0 && connectors.every((c) => c.status !== 'pending');
    if (settled || Date.now() >= deadline) return connectors;
    await new Promise((resolve) => setTimeout(resolve, CONNECTORS_POLL_MS));
  }
}

/** Whether a URL is a claude.ai page, the only kind a connector is authorised on. */
export function isClaudeAiPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'claude.ai';
  } catch {
    return false;
  }
}

/**
 * The claude.ai page that authorises a connector.
 *
 * The CLI looks the server up among those it has listed, so this is asked of
 * a session whose list has settled. `mcpAuthenticate` is on the SDK's Query
 * but missing from its type declarations, hence the checked cast. The page
 * comes from the CLI's reply, so it is checked to be claude.ai's before
 * anything opens it.
 */
export async function claudeAiConnectorAuthPage(session: Query, name: string): Promise<string> {
  const authenticate = (session as {
    mcpAuthenticate?: (serverName: string) => Promise<{ authUrl?: string } | undefined>;
  }).mcpAuthenticate;
  if (typeof authenticate !== 'function') {
    throw new Error('This version of Claude Code cannot authorise connectors.');
  }
  const reply = await authenticate.call(session, name);
  const page = reply?.authUrl;
  if (!page || !isClaudeAiPage(page)) {
    throw new Error(`Claude Code gave no claude.ai page to authorise ${name}.`);
  }
  return page;
}
