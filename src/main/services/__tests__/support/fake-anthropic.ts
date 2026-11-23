/**
 * For tests that run the app's bundled Claude Code for real: a stand-in for
 * Anthropic's Messages API, and an environment that points the CLI at it.
 *
 * The CLI gets a fake key, its own home and config folder — never the
 * user's — and marks each request with the run it belongs to, so one server
 * can answer several runs.
 */

import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

/** The binary the app runs in development: ClaudeCliPaths.getBundledCliPaths. */
export const BUNDLED_CLI = path.resolve(__dirname, '../../../../../node_modules/@anthropic-ai/claude-code/bin/claude.exe');

/** A tool call for the fake API to have Claude make. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A request to the Messages API, as the CLI sent it. */
export interface ApiRequest {
  /** The run it belongs to: its `x-test-run` header. */
  run: string;
  url: string;
  body: { tools?: unknown[]; messages?: unknown[]; system?: unknown };
}

/**
 * What to answer: the calls Claude makes, `[]` to end the turn with a line
 * of text, a promise of either to answer later, or an HTTP error status to
 * refuse the request.
 */
export type ApiAnswer = ToolCall[] | number | Promise<ToolCall[]>;

/** Stream `calls`, or a line of text when there are none, as the API streams a reply. */
function stream(response: http.ServerResponse, calls: ToolCall[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (event: string, data: object) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  if (calls.length === 0) {
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
  }
  calls.forEach((call, index) => {
    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } });
    send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } });
    send('content_block_stop', { type: 'content_block_stop', index });
  });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
  send('message_stop', { type: 'message_stop' });
  response.end();
}

export interface FakeAnthropic {
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * Serve the Messages API from `answer`. Token counts are answered by the
 * server itself, and are not passed to `answer`.
 */
export async function startFakeAnthropic(answer: (request: ApiRequest) => ApiAnswer): Promise<FakeAnthropic> {
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const url = request.url ?? '';
      if (!url.startsWith('/v1/messages') || url.includes('count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      void (async () => {
        const run = String(request.headers['x-test-run'] ?? new URL(url, 'http://x').searchParams.get('run') ?? '');
        const answered = await answer({ run, url, body: JSON.parse(body) });
        if (typeof answered === 'number') {
          response.writeHead(answered, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'test server' } }));
          return;
        }
        stream(response, answered);
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * The CLI's environment for one run, under `root`: a home and config folder
 * of its own, made here, with a `work` folder to run in, and its requests
 * marked with the run's name.
 */
export function cliEnvironment(root: string, run: string, baseUrl: string): Record<string, string> {
  const home = path.join(root, run.replace(/\W+/g, '-'));
  fs.mkdirSync(path.join(home, 'work'), { recursive: true });
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    ANTHROPIC_API_KEY: 'sk-ant-api03-fake-key-for-tests',
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_CUSTOM_HEADERS: `x-test-run: ${run}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

