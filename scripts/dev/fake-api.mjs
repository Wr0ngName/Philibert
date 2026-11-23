#!/usr/bin/env node
/**
 * A stand-in for Anthropic's Messages API, for the development app
 * (`app.mjs start --fake-api`): every message gets a reply streamed as the
 * API streams one — a few words at a time, so the app shows it arriving —
 * and every request is logged, one JSON line each, for a look at what the
 * CLI sent (its system prompt, its messages).
 *
 * A message of the form `run: <command>` has Claude run that command with
 * the Bash tool, in the foreground, then answer once its result is in — for
 * a look at a running command (`run: sleep 120`). `run <ms>: <command>`
 * gives the call that timeout, after which Claude Code moves the command to
 * the background (`run 3000: sleep 60`).
 *
 * `agent: <seconds>` has Claude start a background agent that works that
 * long, a five-second step at a time; `tell agent: <text>` has Claude send
 * the latest agent that text (SendMessage), which it reads at its next step.
 *
 * A compaction (`/compact`) takes COMPACTION_SECONDS: past the 30 s after
 * which Claude Code says again that it is compacting, as a long one does.
 *
 *   node scripts/dev/fake-api.mjs <port> <log file>
 *
 * Nothing reaches Anthropic, and no key is checked. A development tool:
 * nothing here is part of the app or its packages.
 */

import { appendFileSync } from 'node:fs';
import http from 'node:http';

const [port, logFile] = process.argv.slice(2);
if (!port || !logFile) {
  console.error('usage: fake-api.mjs <port> <log file>');
  process.exit(1);
}

/** Between two pieces of a streamed reply: slow enough to watch it arrive. */
const PIECE_DELAY_MS = 120;
let replies = 0;

function replyText(request) {
  const last = request.messages?.at(-1);
  const asked = typeof last?.content === 'string'
    ? last.content
    : (last?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join(' ');
  replies += 1;
  // Paragraphs enough to fill the window, as a real answer often does:
  // scrolling while a reply arrives is part of what there is to see.
  const paragraph = 'This text arrives a few words at a time, as a real reply streams, '
    + 'so the discussion shows it being written before the turn ends.';
  return [`Fake reply ${replies}, to "${asked.replace(/\s+/g, ' ').slice(-60)}".`, ...Array.from({ length: 8 }, (_, i) => `${i + 1}. ${paragraph}`)].join('\n\n');
}

/**
 * The command the message just sent asks for, if it is a `run: <command>`
 * one. Only the last message of the conversation counts: once it carries the call's result, or
 * anything else came after, the call is behind.
 */
function askedCommand(request) {
  const asked = lastAsked(request, /^run(?: (\d+))?: (.+)$/m);
  return asked ? { id: `toolu_fake_${Date.now()}`, name: 'Bash', input: { command: asked[2], description: `Run ${asked[2]}`, timeout: Number(asked[1] ?? 600000) } } : null;
}

/** The text of the message just sent, matched against `pattern`, if it is the user's. */
function lastAsked(request, pattern) {
  // The CLI may follow it with system messages of its own (its environment).
  const last = request.messages?.filter((m) => m.role !== 'system').at(-1);
  if (last?.role !== 'user') return null;
  const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
  if (blocks.some((block) => block.type === 'tool_result')) return null;
  return blocks.filter((block) => block.type === 'text').map((block) => pattern.exec(block.text)).find(Boolean) ?? null;
}

/** How long a compaction's summary takes to come. */
const COMPACTION_SECONDS = 65;

/** Whether this is the request for a compaction's summary (CLI 2.1.280: its last message's opening words). */
function isCompaction(request) {
  return lastAsked(request, /^CRITICAL: Respond with TEXT ONLY\./) !== null;
}

/** What only a development agent's own requests carry: its prompt, which says how long it works. */
const AGENT_MARK = 'DEV-AGENT works for';
const AGENT_STEP_SECONDS = 5;

/**
 * The call for `agent: <seconds>` or `tell agent: <text>` in the main
 * conversation, or the next step of a development agent; null otherwise.
 */
function agentCall(request) {
  const all = JSON.stringify(request.messages ?? []);
  // The agent's own requests: its prompt, and none of the main conversation's calls.
  const marked = new RegExp(`${AGENT_MARK} (\\d+) seconds`).exec(all);
  if (marked && !all.includes('toolu_devagent_')) {
    const steps = (all.match(/"tool_use_id":"toolu_devstep_/g) ?? []).length;
    if (steps >= Math.ceil(Number(marked[1]) / AGENT_STEP_SECONDS)) return { done: true };
    return { id: `toolu_devstep_${Date.now()}`, name: 'Bash', input: { command: `sleep ${AGENT_STEP_SECONDS}`, description: `Step ${steps + 1}` } };
  }
  const start = lastAsked(request, /^agent: (\d+)$/m);
  if (start) {
    return { id: `toolu_devagent_${Date.now()}`, name: 'Agent', input: { description: `Work for ${start[1]}s`, prompt: `${AGENT_MARK} ${start[1]} seconds.`, subagent_type: 'general-purpose', run_in_background: true } };
  }
  const tell = lastAsked(request, /^tell agent: (.+)$/m);
  const agentId = [...all.matchAll(/agentId: ([a-z0-9]+)/g)].at(-1)?.[1];
  if (tell && agentId) return { id: `toolu_devsend_${Date.now()}`, name: 'SendMessage', input: { to: agentId, message: tell[1], summary: tell[1].slice(0, 40) } };
  return null;
}

function usage(text) {
  return { input_tokens: 10, output_tokens: Math.ceil(text.length / 4), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

function message(request, text) {
  return {
    id: `msg_fake_${replies}`,
    type: 'message',
    role: 'assistant',
    model: request.model ?? 'claude-fake',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: usage(text),
  };
}

/** A streamed reply whose one block is `call`. */
function streamToolCall(response, request, { id, name, input }) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  replies += 1;
  send('message_start', { type: 'message_start', message: { ...message(request, ''), content: [], stop_reason: null, usage: { ...usage(''), output_tokens: 1 } } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } });
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: usage(JSON.stringify(input)) });
  send('message_stop', { type: 'message_stop' });
  response.end();
}

async function stream(response, request, text) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const started = message(request, text);
  send('message_start', { type: 'message_start', message: { ...started, content: [], stop_reason: null, usage: { ...usage(''), output_tokens: 1 } } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  const pieces = text.match(/\S+\s*/g) ?? [text];
  for (let i = 0; i < pieces.length; i += 3) {
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: pieces.slice(i, i + 3).join('') } });
    await new Promise((resolve) => setTimeout(resolve, PIECE_DELAY_MS));
  }
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: usage(text) });
  send('message_stop', { type: 'message_stop' });
  response.end();
}

const server = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    let parsed = {};
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      // Logged as it came.
    }
    appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), method: request.method, url: request.url, body: parsed }) + '\n');

    const url = request.url ?? '';
    if (request.method === 'POST' && url.startsWith('/v1/messages') && !url.includes('count_tokens')) {
      // Only Claude's own turns have tools: the CLI's side requests (a title) have none.
      if (parsed.stream && isCompaction(parsed)) {
        setTimeout(() => void stream(response, parsed, '<summary>A development discussion, summarised.</summary>'), COMPACTION_SECONDS * 1000);
        return;
      }
      const call = parsed.tools?.length ? (agentCall(parsed) ?? askedCommand(parsed)) : null;
      if (call && !call.done && parsed.stream) {
        streamToolCall(response, parsed, call);
        return;
      }
      const text = call?.done ? 'The agent is done.' : replyText(parsed);
      if (parsed.stream) {
        void stream(response, parsed, text);
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(message(parsed, text)));
      }
      return;
    }
    if (url.includes('count_tokens')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `the fake API has no ${url}` } }));
  });
});

server.listen(Number(port), '127.0.0.1', () => console.log(`fake API on http://127.0.0.1:${port}`));
