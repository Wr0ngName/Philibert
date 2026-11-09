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

/** Lines of text, each with a diff mark in front. */
function marked(mark: '+' | '-', text: unknown): string[] {
  if (typeof text !== 'string' || text === '') return [];
  return text.replace(/\n$/, '').split('\n').map((line) => `${mark}${line}`);
}

/** One replacement: what it took out, then what it put in. */
function replacement(header: string, oldText: unknown, newText: unknown): string[] {
  return [header, ...marked('-', oldText), ...marked('+', newText)];
}

/**
 * What one file-writing call did, as patch-style lines: a header naming the
 * call, then the lines it removed (-) and added (+). Read off the call's
 * input — the file before it is not known, so a whole-file write shows only
 * what it wrote.
 */
function hunksOf(toolName: string, input: Record<string, unknown>): string[] {
  switch (toolName) {
    case 'Write':
      return ['@@ Write: the whole file @@', ...marked('+', input.content)];
    case 'Edit':
      return replacement(input.replace_all ? '@@ Edit, every occurrence @@' : '@@ Edit @@', input.old_string, input.new_string);
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits as Array<Record<string, unknown>> : [];
      return edits.flatMap((edit, i) =>
        replacement(`@@ Edit ${i + 1} of ${edits.length}${edit.replace_all ? ', every occurrence' : ''} @@`, edit.old_string, edit.new_string));
    }
    case 'NotebookEdit': {
      const cell = typeof input.cell_id === 'string' ? ` cell ${input.cell_id}` : '';
      const mode = typeof input.edit_mode === 'string' ? input.edit_mode : 'replace';
      return mode === 'delete'
        ? [`@@ NotebookEdit: delete${cell} @@`]
        : [`@@ NotebookEdit: ${mode}${cell} @@`, ...marked('+', input.new_source)];
    }
    case 'str_replace_based_edit_tool':
      switch (input.command) {
        case 'create': return ['@@ Create: the whole file @@', ...marked('+', input.file_text)];
        case 'str_replace': return replacement('@@ Edit @@', input.old_str, input.new_str);
        case 'insert': return [`@@ Insert after line ${String(input.insert_line)} @@`, ...marked('+', input.new_str)];
        default: return [];
      }
    default:
      return [];
  }
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/') === b.replace(/\\/g, '/');
}

/** A tool call as the discussion holds it, enough to read what it changed. */
export interface FileWritingCall {
  toolName: string;
  input?: Record<string, unknown>;
  status: string;
}

/**
 * Claude's edits to one file, from its calls that ran, in order: the changes
 * shown for a file outside a git repository, where there is no diff to ask
 * for. Null when none of the calls wrote it.
 */
export function claudeEditsPatch(calls: FileWritingCall[], filePath: string): string | null {
  const hunks = calls
    .filter((call) => call.status === 'executed' && call.input
      && modifiedPathsForTool(call.toolName, call.input).some((path) => samePath(path, filePath)))
    .flatMap((call) => hunksOf(call.toolName, call.input!));
  return hunks.length > 0 ? hunks.join('\n') : null;
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
