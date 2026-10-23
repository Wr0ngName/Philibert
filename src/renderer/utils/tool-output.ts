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
