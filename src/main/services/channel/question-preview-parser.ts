/**
 * Parser for AskUserQuestion `input_preview` payloads sent via Claude Code's
 * `notifications/claude/channel/permission_request` notification.
 *
 * Claude Code's relay (see CLI binary's `St7`) JSON-stringifies the tool input
 * and truncates at 200 chars with a `…` suffix. We try to parse the preview as
 * JSON; if it's truncated or unparseable, we report `truncated: true` with an
 * empty `questions` array so the consumer can render a fallback UI.
 *
 * Pure module — safe to import from both the channel-server bundle and tests.
 */

export interface ParsedQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface ParsedQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: ParsedQuestionOption[];
}

export interface ParsedQuestionsResult {
  questions: ParsedQuestion[];
  truncated: boolean;
}

export function parseQuestionsFromPreview(inputPreview: string): ParsedQuestionsResult {
  if (!inputPreview) return { questions: [], truncated: true };

  const isTruncated = inputPreview.endsWith('…') || inputPreview.endsWith('...');

  let parsed: unknown;
  try {
    parsed = JSON.parse(inputPreview);
  } catch {
    return { questions: [], truncated: true };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { questions: [], truncated: isTruncated };
  }

  const obj = parsed as Record<string, unknown>;
  const rawQuestions = Array.isArray(obj.questions) ? obj.questions : [];
  const out: ParsedQuestion[] = [];

  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== 'object') continue;
    const q = raw as Record<string, unknown>;
    const question = typeof q.question === 'string' ? q.question : '';
    if (!question) continue;

    const rawOptions = Array.isArray(q.options) ? q.options : [];
    const options: ParsedQuestionOption[] = [];
    for (const rawOpt of rawOptions) {
      if (!rawOpt || typeof rawOpt !== 'object') continue;
      const opt = rawOpt as Record<string, unknown>;
      const label = typeof opt.label === 'string' ? opt.label : '';
      if (!label) continue;
      options.push({
        label,
        description: typeof opt.description === 'string' ? opt.description : '',
        ...(typeof opt.preview === 'string' && opt.preview ? { preview: opt.preview } : {}),
      });
    }
    if (options.length === 0) continue;

    out.push({
      question,
      header: typeof q.header === 'string' ? q.header : '',
      multiSelect: q.multiSelect === true,
      options,
    });
  }

  return { questions: out, truncated: isTruncated };
}
