/**
 * Which files a tool call modifies.
 *
 * The file tree's "modified in the last query" indicator used to be fed from
 * one place only: the branch that runs when the user clicks Approve on a
 * permission prompt. Every auto-approved write therefore went unrecorded —
 * including every write after an "always allow", and everything under
 * acceptEdits or bypassPermissions — so the indicator appeared on a handful
 * of files while many more had been changed.
 *
 * Deriving it from the tool call instead covers all of them, and covers the
 * tools the prompt path never classified: it mapped only Edit and Write, so
 * MultiEdit and NotebookEdit were invisible even when prompted.
 */

/**
 * Tools that write to the filesystem at a path named in their input.
 *
 * Bash is deliberately absent: a command can write anywhere, and the paths
 * are not knowable from the input without interpreting a shell line. Those
 * modifications are picked up by the file watcher, not here.
 */
const FILE_WRITING_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  // The Anthropic-defined text editor tool, whose path key differs.
  'str_replace_based_edit_tool',
]);

/** Input keys that carry the target path, in the order they are preferred. */
const PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const;

/**
 * Text-editor-tool commands that only read. `view` is the one that does not
 * modify anything, so a file merely inspected is not reported as changed.
 */
const READ_ONLY_EDITOR_COMMANDS = new Set(['view']);

/** Whether a tool writes to a path named in its input. */
export function isFileWritingTool(toolName: string): boolean {
  return FILE_WRITING_TOOLS.has(toolName);
}

/**
 * The file paths a tool call modifies, or an empty array when it modifies
 * none that can be determined from its input.
 */
export function modifiedPathsForTool(
  toolName: string,
  input: Record<string, unknown> | undefined | null,
): string[] {
  if (!isFileWritingTool(toolName) || !input) return [];

  // The text editor tool multiplexes read and write behind one name.
  const command = input.command;
  if (typeof command === 'string' && READ_ONLY_EDITOR_COMMANDS.has(command)) {
    return [];
  }

  const paths: string[] = [];
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      paths.push(value);
      // One path key per call; the rest are alternative spellings for the
      // same thing rather than additional targets.
      break;
    }
  }
  return paths;
}
