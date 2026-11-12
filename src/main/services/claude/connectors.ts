/**
 * The tools every project has, read and acted on through a CLI session: the
 * claude.ai connectors and the user-wide MCP servers.
 *
 * Connectors are the MCP servers set up on the claude.ai account the CLI is
 * logged in with. The CLI fetches them by itself in every session, with no
 * configuration of ours: `mcpServerStatus()` lists them with `source`
 * 'claudeai', named `claude.ai <name>` (CLAUDE_AI_CONNECTOR_PREFIX). Measured
 * on CLI 2.1.280, in a session that runs no turn:
 *
 *   0.6s  []                                   — not fetched yet
 *   1.1s  Claude Docs pending, Gmail needs-auth, …
 *   2.6s  Claude Docs connected, Gmail needs-auth, …
 *
 * so a read waits for the list to settle rather than taking the first answer.
 * User-wide servers (`claude mcp add --scope user`) are listed with `source`
 * 'user' in the first answer, pending until connected (measured the same way:
 * pending, then connected a quarter of a second later).
 *
 * Authorising a connector is done on claude.ai: for a claudeai-proxy server
 * the CLI's `mcp_authenticate` answers with a claude.ai page to open, and
 * expects no callback. Turning a tool off in a project is the CLI's
 * `mcp_toggle`, which writes `disabledMcpServers` in that project's entry of
 * its global config file, as `/mcp disable` does. One turned off everywhere
 * (mcp-global-off) is not listed at all.
 */

import type { McpServerStatus, Query } from '@anthropic-ai/claude-agent-sdk';

import type { GlobalToolStatus } from '../../../shared/types';

/** How long a read waits for the list to settle: listed, and none pending. */
export const CONNECTORS_SETTLE_MS = 8000;
/** How often it asks in the meantime. */
export const CONNECTORS_POLL_MS = 300;

/** Which of the tools every project has a server is, if one. */
function kindOf(server: McpServerStatus): GlobalToolStatus['kind'] | null {
  // `source` is the field to key trust on; `scope` is what CLIs that predate
  // it report.
  const source = server.source ?? server.scope;
  if (source === 'claudeai') return 'connector';
  if (source === 'user') return 'user';
  return null;
}

function toStatus(server: McpServerStatus, kind: GlobalToolStatus['kind']): GlobalToolStatus {
  return {
    name: server.name,
    kind,
    status: server.status,
    ...(server.error ? { error: server.error } : {}),
    ...(server.tools ? { toolCount: server.tools.length } : {}),
  };
}

/**
 * The connectors and user-wide servers as the session sees them, once
 * settled — or as they stand when CONNECTORS_SETTLE_MS has passed.
 *
 * @param expectConnectors whether the account has claude.ai connectors to
 *   wait for: only a claude.ai sign-in has them, so without one there is
 *   nothing to wait for once the rest are settled.
 */
export async function readGlobalToolStatuses(session: Query, expectConnectors: boolean): Promise<GlobalToolStatus[]> {
  const deadline = Date.now() + CONNECTORS_SETTLE_MS;
  for (;;) {
    const tools = (await session.mcpServerStatus()).flatMap((server) => {
      const kind = kindOf(server);
      return kind ? [toStatus(server, kind)] : [];
    });
    const connectorsIn = !expectConnectors || tools.some((tool) => tool.kind === 'connector');
    const settled = connectorsIn && tools.every((tool) => tool.status !== 'pending');
    if (settled || Date.now() >= deadline) return tools;
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
