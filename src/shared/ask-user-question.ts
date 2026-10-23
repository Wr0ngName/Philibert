/**
 * Parsing for the AskUserQuestion tool's input and for the result Philibert
 * hands back to the model.
 *
 * Shared by the main process, which intercepts the tool to show the question
 * UI, and the renderer, which shows the call afterwards in the tool detail
 * modal. Both read the same untrusted model-produced input, so they must agree
 * on what counts as a question.
 */

import type { AskUserQuestionEntry, AskUserQuestionOption } from './types';

/** Tool name of the SDK's built-in AskUserQuestion */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/**
 * The tool result Philibert returns for an answered AskUserQuestion. Mirrors
 * the SDK's AskUserQuestionOutput; it reaches the model — and the tool's output
 * file — as this object JSON-encoded, verbatim (verified against the bundled
 * CLI: the tool_result content is exactly the string).
 */
export interface AskUserQuestionResultPayload {
  questions: AskUserQuestionEntry[];
  /** Answer per question text. Multi-select answers are labels joined by ", ". */
  answers: Record<string, string>;
  annotations?: Record<string, { preview?: string; notes?: string }>;
}

/**
 * Extract the well-formed questions from an AskUserQuestion input. Questions
 * without text or without a usable option, and options without a label, are
 * dropped rather than shown half-empty.
 */
export function parseAskUserQuestionEntries(input: unknown): AskUserQuestionEntry[] {
  const rawQuestions =
    input && typeof input === 'object' && Array.isArray((input as Record<string, unknown>).questions)
      ? ((input as Record<string, unknown>).questions as unknown[])
      : [];
  const out: AskUserQuestionEntry[] = [];

  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== 'object') continue;
    const q = raw as Record<string, unknown>;

    const question = typeof q.question === 'string' ? q.question : '';
    const header = typeof q.header === 'string' ? q.header : '';
    const multiSelect = typeof q.multiSelect === 'boolean' ? q.multiSelect : false;
    const rawOptions = Array.isArray(q.options) ? q.options : [];
    if (!question || rawOptions.length === 0) continue;

    const options: AskUserQuestionOption[] = [];
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

    out.push({ question, header, multiSelect, options });
  }

  return out;
}

/**
 * Parse an AskUserQuestion tool result back into its payload.
 *
 * Returns null for anything else the tool can produce — e.g. the plain
 * "User cancelled the question." — so the caller can show it as text.
 */
export function parseAskUserQuestionResult(content: string): AskUserQuestionResultPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  if (!record.answers || typeof record.answers !== 'object' || Array.isArray(record.answers)) return null;

  const answers: Record<string, string> = {};
  for (const [question, answer] of Object.entries(record.answers)) {
    if (typeof answer === 'string') answers[question] = answer;
  }

  const result: AskUserQuestionResultPayload = {
    questions: parseAskUserQuestionEntries(record),
    answers,
  };

  if (record.annotations && typeof record.annotations === 'object' && !Array.isArray(record.annotations)) {
    const annotations: NonNullable<AskUserQuestionResultPayload['annotations']> = {};
    for (const [question, raw] of Object.entries(record.annotations)) {
      if (!raw || typeof raw !== 'object') continue;
      const a = raw as Record<string, unknown>;
      const entry = {
        ...(typeof a.preview === 'string' ? { preview: a.preview } : {}),
        ...(typeof a.notes === 'string' ? { notes: a.notes } : {}),
      };
      if (Object.keys(entry).length > 0) annotations[question] = entry;
    }
    if (Object.keys(annotations).length > 0) result.annotations = annotations;
  }

  return result;
}
