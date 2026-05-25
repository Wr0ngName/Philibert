/**
 * Standalone MCP channel server for Claude Code integration.
 *
 * Claude Code spawns this as an MCP subprocess via stdio transport.
 * It bridges between Claude Code (MCP protocol) and the Philibert
 * main process (HTTP long-polling via ChannelBridge).
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

const BRIDGE_URL = process.env.PHILIBERT_BRIDGE_URL || 'http://127.0.0.1:8080';
const CONVERSATION_ID = process.env.PHILIBERT_CONVERSATION_ID || 'default';
const CHANNEL_TOKEN = process.env.PHILIBERT_CHANNEL_TOKEN || '';

const HEADERS: Record<string, string> = {
  'Authorization': `Bearer ${CHANNEL_TOKEN}`,
  'Content-Type': 'application/json',
};

const log = (level: string, msg: string, extra?: Record<string, unknown>) => {
  const entry = { ts: new Date().toISOString(), level, msg, ...extra };
  process.stderr.write(JSON.stringify(entry) + '\n');
};

const server = new Server(
  { name: 'philibert', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
    },
  },
);

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
        return { content: [{ type: 'text', text: `Error: bridge returned ${resp.status}` }] };
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

async function pollMessages(): Promise<void> {
  // Initial delay to let Claude Code finish initialization
  await sleep(3000);

  while (true) {
    try {
      const resp = await fetch(
        `${BRIDGE_URL}/api/channel/poll/${encodeURIComponent(CONVERSATION_ID)}?timeout=30`,
        { method: 'GET', headers: HEADERS, signal: AbortSignal.timeout(35000) },
      );

      if (!resp.ok) {
        log('warn', 'Poll failed', { status: resp.status });
        await sleep(5000);
        continue;
      }

      const data = (await resp.json()) as { messages?: Array<{ content: string; meta: Record<string, string> }> };
      const messages = data.messages || [];

      for (const msg of messages) {
        try {
          await server.notification({
            method: 'notifications/claude/channel',
            params: {
              content: msg.content,
              meta: msg.meta || {},
            },
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
      if (err instanceof Error && err.name === 'TimeoutError') {
        continue;
      }
      log('error', 'Poll error', { error: err instanceof Error ? err.message : String(err) });
      await sleep(5000);
    }
  }
}

async function pollVerdicts(): Promise<void> {
  await sleep(3000);

  while (true) {
    try {
      const resp = await fetch(
        `${BRIDGE_URL}/api/channel/permission/poll/${encodeURIComponent(CONVERSATION_ID)}?timeout=30`,
        { method: 'GET', headers: HEADERS, signal: AbortSignal.timeout(35000) },
      );

      if (!resp.ok) {
        await sleep(5000);
        continue;
      }

      const data = (await resp.json()) as { verdicts?: Array<{ requestId: string; behavior: string }> };
      const verdicts = data.verdicts || [];

      for (const verdict of verdicts) {
        try {
          await server.notification({
            method: 'notifications/claude/channel/permission',
            params: {
              request_id: verdict.requestId,
              behavior: verdict.behavior,
            },
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
      if (err instanceof Error && err.name === 'TimeoutError') {
        continue;
      }
      log('error', 'Verdict poll error', {
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(5000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  log('info', 'Channel server starting', {
    bridgeUrl: BRIDGE_URL,
    conversationId: CONVERSATION_ID,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('info', 'Channel server connected via stdio');

  // Run pollers concurrently — they never return under normal operation
  await Promise.all([pollMessages(), pollVerdicts()]);
}

main().catch((err) => {
  log('error', 'Channel server crashed', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
