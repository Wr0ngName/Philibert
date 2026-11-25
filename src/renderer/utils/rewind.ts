/**
 * What the discussion says of a rewind: the divider drawn above the prompt
 * the conversation went back to, and the note a rewind of files alone adds.
 */

import type { RewindRecord } from '@shared/types';

/** How much of the prompt names it: its first line, cut to this. */
const PROMPT_NAME_LENGTH = 60;

/** A prompt, named by its first line. */
export function promptName(content: string): string {
  const line = content.trim().split('\n')[0].trim();
  if (!line) return '(empty message)';
  return line.length > PROMPT_NAME_LENGTH ? `${line.slice(0, PROMPT_NAME_LENGTH - 1)}…` : line;
}

/** What the files part of a rewind did, or null when files were not asked for. */
export function restoredFilesText(record: RewindRecord): string | null {
  const files = record.files;
  if (!files) return null;
  if (files.changed.length === 0) return 'no file differed from that point';
  const count = `${files.changed.length} file${files.changed.length === 1 ? '' : 's'}`;
  return `${count} restored (+${files.insertions} / -${files.deletions})`;
}

/** Files left alone by a partial restore, said as a warning; null when none were. */
export function skippedLinksText(record: RewindRecord): string | null {
  const skipped = record.files?.skippedLinks;
  if (!skipped) return null;
  return `${skipped} tracked file${skipped === 1 ? ' was' : 's were'} left alone — a link, a parent that `
    + 'no longer resolves where it did, or a backup that could not be read safely: the restore was partial';
}

/** The divider's line, above the prompt rewound to. */
export function rewindDividerText(record: RewindRecord, prompt: string): string {
  const files = restoredFilesText(record);
  return `Rewound to "${promptName(prompt)}" · ${files ?? 'files kept as they are'}`;
}

/** The note a rewind of files alone adds: the conversation goes on as it was. */
export function filesRewindNote(record: RewindRecord, prompt: string): string {
  const files = restoredFilesText(record) ?? 'no file restored';
  const skipped = skippedLinksText(record);
  return `Files rewound to "${promptName(prompt)}": ${files}${skipped ? `. ${skipped}` : ''}. The conversation goes on as it was.`;
}
