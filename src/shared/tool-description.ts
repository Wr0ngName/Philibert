/**
 * The one-line label of a tool call, as its row in the discussion shows it.
 *
 * Shared by the main process, which stores it on the call as it streams and
 * on an agent's calls read back from its transcript, and by the row itself,
 * which works it out from the call's input — so a conversation saved with an
 * older label reads the same as a new one.
 */

import { SEND_MESSAGE_TOOL, sendMessagePreview } from './send-message';
import type { TaskListItem, ToolUseInfo } from './types';

/** Longest command or prompt shown when a call says nothing about itself. */
const EXCERPT_LENGTH = 80;

/**
 * What a call says it is for: the `description` Claude writes on a command
 * or an agent ("Run 10 bots with personas and panel, 10 minutes"). It is
 * also the name a background task is listed under, so the row and the
 * background list name the same work the same way.
 */
function statedPurpose(input: Record<string, unknown>): string {
  const description = input.description;
  return typeof description === 'string' ? description.trim() : '';
}

function excerpt(value: unknown): string {
  return (typeof value === 'string' ? value : '').slice(0, EXCERPT_LENGTH);
}

/** "<prefix>: <value>", or nothing when the call has no such value to name it by. */
function namedBy(prefix: string, value: unknown): string {
  return typeof value === 'string' && value.trim() ? `${prefix}: ${value.trim()}` : '';
}

/** A status as a TaskUpdate sets it, in words. */
const TASK_STATUS_WORDS: Record<TaskListItem['status'], string> = {
  pending: 'back to pending',
  in_progress: 'in progress',
  completed: 'completed',
  deleted: 'deleted',
};

/** Fields a TaskUpdate rewrites without the row having room to show the new value. */
const TASK_TEXT_FIELDS: ReadonlyArray<[field: string, name: string]> = [
  ['description', 'description'],
  ['activeForm', 'progress line'],
  ['metadata', 'metadata'],
];

function taskIds(value: unknown): string {
  return Array.isArray(value) ? value.map((id) => `#${String(id)}`).join(', ') : '';
}

/**
 * What a TaskUpdate does, read off its input (the CLI's TaskUpdate schema):
 * "Task #3: completed", "Task #4: renamed to "Merge main", blocked by #3",
 * "Task #9: description updated".
 */
function describeTaskUpdate(input: Record<string, unknown>): string {
  const changes: string[] = [];
  const status = input.status as TaskListItem['status'] | undefined;
  if (status && status in TASK_STATUS_WORDS) changes.push(TASK_STATUS_WORDS[status]);
  if (typeof input.subject === 'string' && input.subject.trim()) changes.push(`renamed to "${input.subject.trim()}"`);
  if (typeof input.owner === 'string' && input.owner.trim()) changes.push(`owner ${input.owner.trim()}`);
  const blockedBy = taskIds(input.addBlockedBy);
  if (blockedBy) changes.push(`blocked by ${blockedBy}`);
  const blocks = taskIds(input.addBlocks);
  if (blocks) changes.push(`blocks ${blocks}`);
  const rewritten = TASK_TEXT_FIELDS.filter(([field]) => input[field] !== undefined).map(([, name]) => name);
  if (rewritten.length > 0) changes.push(`${rewritten.join(', ')} updated`);
  const task = input.taskId === undefined ? 'Task' : `Task #${String(input.taskId)}`;
  return changes.length > 0 ? `${task}: ${changes.join(', ')}` : task;
}

/**
 * The label for a call of `toolName` with `input`. Empty when there is
 * nothing to add to the tool's name, which the row shows anyway.
 */
export function describeToolUse(toolName: string, input: Record<string, unknown>): string {
  const purpose = statedPurpose(input);
  switch (toolName) {
    case 'Bash':
    case 'PowerShell': return purpose || `Run: ${excerpt(input.command)}`;
    case 'Agent': return purpose || `Agent: ${excerpt(input.prompt)}`;
    case 'Read': return `Read: ${input.file_path}`;
    case 'Edit': return `Edit: ${input.file_path}`;
    case 'Write': return `Write: ${input.file_path}`;
    case 'Glob': return `Search files: ${input.pattern}`;
    case 'Grep': return `Search: ${input.pattern}`;
    // What was searched for, and the page fetched: its whole address, which
    // the row cuts at its end, so the site stays in view.
    case 'WebSearch': return namedBy('Web search', input.query);
    case 'WebFetch': return namedBy('Fetch', input.url);
    case SEND_MESSAGE_TOOL: return excerpt(sendMessagePreview(input));
    // Its description, when it has one, is the task's new description,
    // not what the call is for.
    case 'TaskUpdate': return describeTaskUpdate(input);
    default: return purpose;
  }
}

/** The label a call's row shows: from its input when it has one. */
export function toolCallLabel(toolUse: Pick<ToolUseInfo, 'toolName' | 'description' | 'input'>): string {
  return toolUse.input ? describeToolUse(toolUse.toolName, toolUse.input) : toolUse.description;
}
