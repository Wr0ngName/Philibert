/**
 * Standalone MCP channel server for Claude Code integration.
 *
 * Claude Code spawns this as an MCP subprocess via stdio transport.
 * It bridges between Claude Code (MCP protocol) and the Philibert
 * main process (HTTP long-polling via ChannelBridge).
 *
 * Notifications are written directly to the transport (not via
 * server.notification()) because Claude Code's channel protocol
 * uses custom notification methods that the MCP SDK doesn't know about.
 *
 * Run as: node channel-server.cjs
 *
 * Environment variables (set via .mcp.json env block):
 *   PHILIBERT_BRIDGE_URL         Base URL of the bridge HTTP server
 *   PHILIBERT_CONVERSATION_ID    Conversation ID to bind to
 *   PHILIBERT_CHANNEL_TOKEN      Bearer token for bridge authentication
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { JSONRPCNotification } from '@modelcontextprotocol/sdk/types.js';

const BRIDGE_URL = process.env.PHILIBERT_BRIDGE_URL || 'http://127.0.0.1:8080';
const CONVERSATION_ID = process.env.PHILIBERT_CONVERSATION_ID || 'default';
const CHANNEL_TOKEN = process.env.PHILIBERT_CHANNEL_TOKEN || '';

const HEADERS: Record<string, string> = {
  'Authorization': `Bearer ${CHANNEL_TOKEN}`,
  'Content-Type': 'application/json',
};

const HEARTBEAT_INTERVAL_MS = 15000;
const BRIDGE_READY_POLL_MS = 500;
const BRIDGE_READY_TIMEOUT_MS = 30000;
const MAX_BACKOFF_MS = 30000;
const INITIAL_BACKOFF_MS = 1000;

let shuttingDown = false;

const log = (level: string, msg: string, extra?: Record<string, unknown>) => {
  const entry = { ts: new Date().toISOString(), level, msg, ...extra };
  process.stderr.write(JSON.stringify(entry) + '\n');
};

const server = new Server(
  { name: 'philibert', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions:
      'You are connected to a chat UI via the Philibert channel. ' +
      'Messages from the user arrive as channel notifications. ' +
      'You MUST reply using the "reply" tool with the "text" parameter. ' +
      'Do NOT write your response to stdout — always use the reply tool.',
  },
);

let transport: StdioServerTransport;

// Handle permission requests from Claude Code.
// When Claude Code needs approval for a tool (Read, Bash, etc.), it sends a
// notification to the channel server. We forward it to the bridge, which relays
// it to the Philibert UI. The user's verdict comes back via the verdict poller.
server.fallbackNotificationHandler = async (notification: { method: string; params?: Record<string, unknown> }) => {
  if (notification.method === 'notifications/claude/channel/permission_request') {
    const params = notification.params || {};
    const requestId = String(params.request_id || params.requestId || '');
    const toolName = String(params.tool_name || params.toolName || 'unknown');
    const description = String(params.description || '');
    const inputPreview = String(params.input_preview || params.inputPreview || '');

    if (!requestId) {
      log('warn', 'Permission request missing request_id', { params });
      return;
    }

    log('info', 'Received permission request from Claude Code', {
      requestId,
      toolName,
      description: description.slice(0, 100),
    });

    try {
      const resp = await fetch(
        `${BRIDGE_URL}/api/channel/permission/request/${encodeURIComponent(CONVERSATION_ID)}`,
        {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify({ requestId, toolName, description, inputPreview }),
        },
      );

      if (!resp.ok) {
        log('error', 'Failed to forward permission request to bridge', {
          status: resp.status,
          body: await resp.text(),
        });
      }
    } catch (err) {
      log('error', 'Permission request forwarding failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    log('debug', 'Unhandled notification', { method: notification.method });
  }
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a message back to the Philibert chat UI',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: { type: 'string', description: 'Message text to send' },
        },
        required: ['text'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'reply') {
    const text = (args as Record<string, unknown>)?.text;
    if (typeof text !== 'string' || !text) {
      return { content: [{ type: 'text', text: 'Error: missing text argument' }] };
    }

    try {
      const resp = await fetch(
        `${BRIDGE_URL}/api/channel/reply/${encodeURIComponent(CONVERSATION_ID)}`,
        { method: 'POST', headers: HEADERS, body: JSON.stringify({ text }) },
      );

      if (!resp.ok) {
        const body = await resp.text();
        log('error', 'Reply failed', { status: resp.status, body });
        return { content: [{ type: 'text', text: `Error: bridge returned ${resp.status}: ${body}` }] };
      }

      return { content: [{ type: 'text', text: 'Message sent' }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', 'Reply request failed', { error: msg });
      return { content: [{ type: 'text', text: `Error: ${msg}` }] };
    }
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
});

async function sendRawNotification(
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  const notification: JSONRPCNotification = {
    jsonrpc: '2.0',
    method,
    params,
  };
  await transport.send(notification);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextBackoff(current: number): number {
  return Math.min((current || INITIAL_BACKOFF_MS) * 2, MAX_BACKOFF_MS);
}

async function waitForBridge(): Promise<void> {
  const deadline = Date.now() + BRIDGE_READY_TIMEOUT_MS;
  log('info', 'Waiting for bridge to be ready', { url: BRIDGE_URL });

  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${BRIDGE_URL}/api/channel/health`, {
        method: 'GET',
        headers: HEADERS,
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        log('info', 'Bridge is ready');
        return;
      }
    } catch {
      // Bridge not ready yet
    }
    await sleep(BRIDGE_READY_POLL_MS);
  }

  log('error', 'Bridge did not become ready within timeout', {
    timeoutMs: BRIDGE_READY_TIMEOUT_MS,
  });
  process.exit(1);
}

async function heartbeat(): Promise<void> {
  while (!shuttingDown) {
    try {
      await fetch(`${BRIDGE_URL}/api/channel/health`, {
        method: 'GET',
        headers: HEADERS,
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      log('warn', 'Heartbeat failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await sleep(HEARTBEAT_INTERVAL_MS);
  }
}

async function pollMessages(): Promise<void> {
  log('info', 'Message poller started', { conversationId: CONVERSATION_ID });
  let backoffMs = 0;

  while (!shuttingDown) {
    try {
      const resp = await fetch(
        `${BRIDGE_URL}/api/channel/poll/${encodeURIComponent(CONVERSATION_ID)}?timeout=30`,
        { method: 'GET', headers: HEADERS, signal: AbortSignal.timeout(35000) },
      );

      if (!resp.ok) {
        log('warn', 'Poll failed', { status: resp.status });
        backoffMs = nextBackoff(backoffMs);
        await sleep(backoffMs);
        continue;
      }

      backoffMs = 0;

      const data = (await resp.json()) as { messages?: Array<{ content: string; meta: Record<string, string> }> };
      const messages = data.messages || [];

      for (const msg of messages) {
        try {
          await sendRawNotification('notifications/claude/channel', {
            content: msg.content,
            meta: msg.meta || {},
          });
          log('info', 'Pushed channel notification', {
            contentLength: msg.content.length,
          });
        } catch (err) {
          log('error', 'Failed to push notification', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      if (shuttingDown) break;
      if (err instanceof Error && err.name === 'TimeoutError') {
        continue;
      }
      log('error', 'Poll error', { error: err instanceof Error ? err.message : String(err) });
      backoffMs = nextBackoff(backoffMs);
      await sleep(backoffMs);
    }
  }
}

async function pollVerdicts(): Promise<void> {
  log('info', 'Verdict poller started', { conversationId: CONVERSATION_ID });
  let backoffMs = 0;

  while (!shuttingDown) {
    try {
      const resp = await fetch(
        `${BRIDGE_URL}/api/channel/permission/poll/${encodeURIComponent(CONVERSATION_ID)}?timeout=30`,
        { method: 'GET', headers: HEADERS, signal: AbortSignal.timeout(35000) },
      );

      if (!resp.ok) {
        backoffMs = nextBackoff(backoffMs);
        await sleep(backoffMs);
        continue;
      }

      backoffMs = 0;

      const data = (await resp.json()) as { verdicts?: Array<{ requestId: string; behavior: string }> };
      const verdicts = data.verdicts || [];

      for (const verdict of verdicts) {
        try {
          await sendRawNotification('notifications/claude/channel/permission', {
            request_id: verdict.requestId,
            behavior: verdict.behavior,
          });
          log('info', 'Pushed permission verdict', {
            requestId: verdict.requestId,
            behavior: verdict.behavior,
          });
        } catch (err) {
          log('error', 'Failed to push verdict notification', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      if (shuttingDown) break;
      if (err instanceof Error && err.name === 'TimeoutError') {
        continue;
      }
      log('error', 'Verdict poll error', {
        error: err instanceof Error ? err.message : String(err),
      });
      backoffMs = nextBackoff(backoffMs);
      await sleep(backoffMs);
    }
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'Channel server shutting down');

  try {
    await server.close();
  } catch (err) {
    log('warn', 'Error closing MCP server', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

async function main(): Promise<void> {
  log('info', 'Channel server starting', {
    bridgeUrl: BRIDGE_URL,
    conversationId: CONVERSATION_ID,
  });

  transport = new StdioServerTransport();
  await server.connect(transport);

  log('info', 'Channel server connected via stdio');

  await waitForBridge();

  await Promise.all([pollMessages(), pollVerdicts(), heartbeat()]);
}

main().catch((err) => {
  log('error', 'Channel server crashed', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
