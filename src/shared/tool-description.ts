/**
 * The one-line label of a tool call, as its row in the discussion shows it.
 *
 * Shared by the main process, which stores it on the call as it streams and
 * on an agent's calls read back from its transcript, and by the row itself,
 * which works it out from the call's input — so a conversation saved with an
 * older label reads the same as a new one.
 */

import type { ToolUseInfo } from './types';

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
    default: return purpose;
  }
}

/** The label a call's row shows: from its input when it has one. */
export function toolCallLabel(toolUse: Pick<ToolUseInfo, 'toolName' | 'description' | 'input'>): string {
  return toolUse.input ? describeToolUse(toolUse.toolName, toolUse.input) : toolUse.description;
}
