/**
 * Reading a background task's output, and an agent's transcript, for the
 * task detail view.
 *
 * Both are asked for by task id rather than by path. The path comes from the
 * CLI — a command's from its tool result, an agent's from its structured
 * result, either from the completion notice — so the main process already
 * knows it, and a renderer that could name any path to read would be a file
 * reader for anything. A path is accepted from the renderer only for a task
 * this process never saw (one from before a restart), and only when it has
 * the exact shape the CLI gives task output files.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';

import type { ChatMessage, TaskOutputChunk, ToolUseInfo } from '../../../shared/types';

import { describeToolUse } from './SDKMessageHandler';
import { toolResultParts } from './tool-result-images';

/** At most this much of an output is sent at once: its tail. */
export const MAX_TASK_OUTPUT_BYTES = 512 * 1024;

/**
 * Whether a path the renderer named is a task output file of the given task:
 * `<tmpdir>/…/tasks/<taskId>.output`, as the CLI writes them (2.1.280:
 * `/tmp/claude-<uid>/<project>/<session>/tasks/<id>.output`).
 */
export function isTaskOutputPath(candidate: string, taskId: string): boolean {
  const resolved = path.resolve(candidate);
  const tmp = path.resolve(os.tmpdir()) + path.sep;
  return resolved.startsWith(tmp)
    && path.basename(resolved) === `${taskId}.output`
    && path.basename(path.dirname(resolved)) === 'tasks';
}

/**
 * Read a task's output from `fromByte` on, capped to its last
 * MAX_TASK_OUTPUT_BYTES. Read in increments by a view that follows a running
 * command, so it only ever receives what was appended.
 */
export async function readTaskOutput(file: string, fromByte: number): Promise<TaskOutputChunk> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    // A file that shrank was replaced; start it over.
    const from = fromByte > size ? 0 : fromByte;
    const start = Math.max(from, size - MAX_TASK_OUTPUT_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, start);
    return { text: buffer.toString('utf-8'), nextByte: size, skippedBytes: start - from };
  } finally {
    await handle.close();
  }
}

/**
 * An agent's transcript as the chat messages the discussion is drawn from,
 * so the same list renders it: what it was asked, what it said, the calls it
 * made with their results.
 *
 * Ids come from the transcript's own uuids, so reading it again as the agent
 * goes on yields the same ids for what was already there — the list keeps
 * its rows and its scroll position, and only what is new is added.
 *
 * `storeResult` keeps a call's result where the tool detail view reads it
 * from, and returns that file.
 */
export function transcriptToMessages(
  entries: SessionMessage[],
  storeResult: (toolUseBlockId: string, content: string) => string,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const toolMessages = new Map<string, ChatMessage>();

  for (const entry of entries) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const content = (entry.message as { content?: unknown } | null)?.content;
    // Not in SessionMessage's type, but on every entry read back (2.1.280).
    const stamp = Date.parse((entry as { timestamp?: string }).timestamp ?? '');
    const timestamp = Number.isNaN(stamp) ? 0 : stamp;

    if (typeof content === 'string') {
      if (content.trim()) messages.push({ id: entry.uuid, role: entry.type, content, timestamp });
      continue;
    }
    if (!Array.isArray(content)) continue;

    content.forEach((block: { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }, index) => {
      const id = `${entry.uuid}:${index}`;
      if (block.type === 'text' && block.text?.trim()) {
        messages.push({ id, role: entry.type, content: block.text, timestamp });
        return;
      }
      if (entry.type === 'assistant' && block.type === 'tool_use' && block.id && block.name) {
        const input = (block.input ?? {}) as Record<string, unknown>;
        const toolUse: ToolUseInfo = {
          actionId: block.id,
          toolName: block.name,
          description: describeToolUse(block.name, input),
          status: 'approved',
          toolUseBlockId: block.id,
          input,
        };
        const message: ChatMessage = { id, role: 'assistant', content: '', timestamp, toolUse };
        messages.push(message);
        toolMessages.set(block.id, message);
        return;
      }
      if (block.type === 'tool_result' && block.tool_use_id) {
        const call = toolMessages.get(block.tool_use_id);
        if (!call?.toolUse) return;
        const { text } = toolResultParts(block.content, undefined);
        call.toolUse = {
          ...call.toolUse,
          status: block.is_error ? 'failed' : 'executed',
          outputFile: storeResult(block.tool_use_id, text),
        };
      }
    });
  }

  return messages;
}
