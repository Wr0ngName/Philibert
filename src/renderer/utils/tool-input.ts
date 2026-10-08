/**
 * Presenting a tool's input parameters for display.
 *
 * Shared by the tool detail modal and the background task detail modal: a
 * background task is spawned by a tool call, and the input to that call — the
 * shell command, or a sub-agent's prompt and type — is the detail a reader
 * actually wants. Showing it in one place and not the other is what made the
 * background modal read as empty while a task was still running, since every
 * other field it had (summary, output file, model, tokens) only arrives at
 * the end.
 */

/** One input parameter, formatted for display. */
export interface InputParam {
  key: string;
  label: string;
  value: string;
  /** Whether the value wants its own block rather than an inline row. */
  isBlock: boolean;
}

/** Friendlier labels for the parameter names that come up most. */
const PARAM_LABELS: Record<string, string> = {
  file_path: 'File',
  content: 'Content',
  command: 'Command',
  old_string: 'Original',
  new_string: 'Replacement',
  pattern: 'Pattern',
  path: 'Path',
  offset: 'Offset',
  limit: 'Limit',
  description: 'Description',
  replace_all: 'Replace All',
  timeout: 'Timeout',
  cwd: 'Working Directory',
  // Task/Agent spawns, which is what an 'agent' background task is.
  prompt: 'Prompt',
  subagent_type: 'Agent',
  run_in_background: 'Run In Background',
};

/** Length beyond which a string reads better as a block than a row. */
const BLOCK_THRESHOLD = 80;

/** Parameters always worth a block, however short they happen to be. */
const ALWAYS_BLOCK = ['content', 'command', 'old_string', 'new_string', 'prompt'];

function isBlockValue(key: string, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (ALWAYS_BLOCK.includes(key)) return true;
  return value.length > BLOCK_THRESHOLD || value.includes('\n');
}

/**
 * Format a tool's input object into displayable parameters.
 *
 * Objects and arrays are pretty-printed as JSON rather than stringified to
 * "[object Object]"; null and undefined become empty so a present-but-unset
 * parameter still shows its name.
 */
export function formatToolInput(input: Record<string, unknown> | undefined | null): InputParam[] {
  if (!input) return [];

  return Object.entries(input).map(([key, value]) => {
    let displayValue: string;
    if (value === null || value === undefined) {
      displayValue = '';
    } else if (typeof value === 'string') {
      displayValue = value;
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      displayValue = String(value);
    } else {
      displayValue = JSON.stringify(value, null, 2);
    }

    return {
      key,
      label: PARAM_LABELS[key] || key,
      value: displayValue,
      isBlock: isBlockValue(key, value),
    };
  });
}
