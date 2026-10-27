/**
 * What a tool call's Output section shows (ToolCallView): the output still
 * being read, a failure to read it, its text, or a note saying why there is
 * none to show.
 */
export type ToolCallOutput =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  /** `skippedBytes`: how much came before the text and is not shown. */
  | { kind: 'text'; text: string; skippedBytes?: number }
  | { kind: 'note'; message: string };

/**
 * Presenting a tool's output file for display.
 *
 * Many tool results are JSON — MCP tools, and AskUserQuestion's answer
 * payload — written compact on a single line. Pretty-print a JSON object or
 * array so it reads as structure; leave everything else exactly as written.
 */
export function formatToolOutput(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return content;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object' ? JSON.stringify(parsed, null, 2) : content;
  } catch {
    return content;
  }
}
