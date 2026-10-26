/**
 * Reading a background task's output, and an agent's transcript, for the
 * task detail view.
 *
 * Both are asked for by task id rather than by path: a renderer that could
 * name any path to read would be a file reader for anything. The main process
 * has the path from the CLI's structured fields when it was told one — an
 * agent's `outputFile`, a completion notice's `output_file` — and otherwise
 * finds it by the session and task ids; see locateTaskOutput.
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
 * The temp directory the CLI is given (`CLAUDE_CODE_TMPDIR`), so that its task
 * output files are under a directory this app knows rather than one it would
 * have to work out.
 *
 * Needed because nothing in the protocol names a running command's output
 * file: the Bash tool's structured result carries only `backgroundTaskId`
 * (BashOutput, sdk-tools.d.ts), the completion notice's `output_file` arrives
 * only once the command has ended, and no control request reads task output.
 * A user who set CLAUDE_CODE_TMPDIR themselves keeps theirs.
 */
export function cliTempRoot(): string {
  return process.env.CLAUDE_CODE_TMPDIR || path.join(os.tmpdir(), 'philibert-cli');
}

/** How deep under the temp root a session's directory sits: `claude-<uid>/<project>/<session>`. */
const SESSION_DIR_DEPTH = 3;

/**
 * A task's output file, found under the CLI's temp root by the session and
 * task ids — the two things the protocol does state. Measured layout (CLI
 * 2.1.280): `<root>/claude-<uid>/<project>/<sessionId>/tasks/<taskId>.output`.
 * Looked for by the ids rather than built from that layout, so a change in the
 * levels above the session does not lose it.
 *
 * Symbolic links are not followed into: the tree is the CLI's, and a planted
 * link must not turn this into a reader of somewhere else.
 */
export async function locateTaskOutput(root: string, sessionId: string, taskId: string): Promise<string | undefined> {
  async function search(dir: string, depth: number): Promise<string | undefined> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (entry.name === sessionId) {
        const file = path.join(child, 'tasks', `${taskId}.output`);
        try {
          await fs.promises.access(file);
          return file;
        } catch {
          continue;
        }
      }
      if (depth < SESSION_DIR_DEPTH) {
        const found = await search(child, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  }
  return search(root, 1);
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
