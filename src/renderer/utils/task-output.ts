/**
 * Making sense of a background task's output file.
 *
 * The task-detail modal read that file and showed it verbatim, which is right
 * for some tasks and unreadable for others — observed against the real CLI,
 * running one background shell command and one background agent:
 *
 *   shell task  17 bytes      "hello-from-shell\n"            plain text
 *   agent task  55,597 bytes  {"parentUuid":null,…}\n{…}\n…   JSONL transcript
 *
 * The agent's file is its whole transcript, one JSON object per line — a
 * symlink to the session's `subagents/agent-<id>.jsonl`. Dumped into the modal
 * that is 55KB of JSON for a one-word answer, which is what "shows raw JSON"
 * meant. It is also not a single JSON document, so parsing the file as one
 * fails; each line has to be taken separately.
 *
 * The entry and block types handled here were read off a real transcript
 * rather than guessed: `user`, `assistant` and `attachment` entries, with
 * content that is either a plain string or an array of blocks.
 */

/** One readable step of an agent's activity. */
export interface TranscriptStep {
  role: 'user' | 'assistant';
  /** Prose the agent read or wrote. */
  text?: string;
  /** Tool it called, when the step is a tool use. */
  toolName?: string;
  /** A short rendering of that call's input. */
  toolInput?: string;
}

export type TaskOutput =
  | { kind: 'empty' }
  /** Not a transcript — a command's output, shown as it is. */
  | { kind: 'text'; text: string }
  | {
      kind: 'transcript';
      steps: TranscriptStep[];
      /** Entries carrying no readable activity, counted rather than shown. */
      skipped: number;
    };

/** Entries that are machinery rather than activity. */
const NOISE_TYPES = new Set(['attachment', 'system', 'summary', 'file-history-snapshot']);

/** A short, single-line rendering of a tool call's input. */
function summariseToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  // The fields worth showing, in the order a reader would want them. Chosen
  // because they are what identifies a call: what it ran, or what it touched.
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'prompt', 'description']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function stepsFromContent(role: 'user' | 'assistant', content: unknown): TranscriptStep[] {
  if (typeof content === 'string') {
    return content.trim() ? [{ role, text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const steps: TranscriptStep[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const typed = block as { type?: string; text?: string; name?: string; input?: unknown; content?: unknown };

    if (typed.type === 'text' && typeof typed.text === 'string' && typed.text.trim()) {
      steps.push({ role, text: typed.text });
      continue;
    }
    if (typed.type === 'tool_use' && typeof typed.name === 'string') {
      steps.push({ role, toolName: typed.name, toolInput: summariseToolInput(typed.input) });
      continue;
    }
    if (typed.type === 'tool_result') {
      // The result's text is the tool's own output, often long and already
      // reflected in what the agent says next. Recorded as a step so the
      // sequence reads correctly, without the payload.
      steps.push({ role, text: undefined, toolName: undefined });
    }
  }
  return steps.filter((step) => step.text !== undefined || step.toolName !== undefined);
}

/**
 * Turn a task's output file into something renderable.
 *
 * A file is treated as a transcript only when its first non-empty line is a
 * JSON object with a `type` — which is what the CLI writes for an agent and
 * what no command output looks like. Anything else is shown as text, so a
 * command that happens to print JSON still appears as the user expects.
 */
export function parseTaskOutput(raw: string | null | undefined): TaskOutput {
  if (raw === null || raw === undefined || !raw.trim()) return { kind: 'empty' };

  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const first = tryParseEntry(lines[0]);
  if (!first) return { kind: 'text', text: raw };

  const steps: TranscriptStep[] = [];
  let skipped = 0;

  for (const line of lines) {
    const entry = tryParseEntry(line);
    // A transcript can have a truncated final line, or a line this version
    // does not recognise. Counting those is honest; discarding them silently
    // is how the modal came to show nothing useful.
    if (!entry) {
      skipped += 1;
      continue;
    }
    if (NOISE_TYPES.has(entry.type)) {
      skipped += 1;
      continue;
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') {
      skipped += 1;
      continue;
    }

    const message = entry.message as { content?: unknown } | undefined;
    const produced = stepsFromContent(entry.type, message?.content);
    if (produced.length === 0) skipped += 1;
    steps.push(...produced);
  }

  return { kind: 'transcript', steps, skipped };
}

function tryParseEntry(line: string | undefined): { type: string; message?: unknown } | null {
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const typed = parsed as { type?: unknown; message?: unknown };
    if (typeof typed.type !== 'string') return null;
    return { type: typed.type, message: typed.message };
  } catch {
    return null;
  }
}
