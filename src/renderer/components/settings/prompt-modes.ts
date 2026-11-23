/**
 * The choices of Claude Code's system prompt (@shared/system-prompt), as the
 * general settings and a project's page offer them.
 */

import type { ClaudeCodePromptMode, ProjectSystemPrompt } from '@shared/system-prompt';

export interface PromptModeOption<T extends string> {
  value: T;
  label: string;
  description: string;
}

export const GENERAL_PROMPT_MODES: PromptModeOption<ClaudeCodePromptMode>[] = [
  { value: 'auto', label: 'In git repositories', description: 'Where there is code to work on' },
  { value: 'on', label: 'Always', description: 'In every folder' },
  { value: 'off', label: 'Never', description: 'Only your instructions' },
];

/** A project's choice: its own, or 'general' to follow the general setting. */
export type ProjectPromptMode = NonNullable<ProjectSystemPrompt['claudeCodePrompt']> | 'general';

/**
 * A project's choices, the general one saying what it comes to here: whether
 * the general setting uses the prompt in this folder, or null while that is
 * not known yet.
 */
export function projectPromptModes(generalUsesItHere: boolean | null): PromptModeOption<ProjectPromptMode>[] {
  return [
    {
      value: 'general',
      label: 'As in general',
      description: generalUsesItHere === null ? 'As the general setting says' : generalUsesItHere ? 'Used here' : 'Not used here',
    },
    { value: 'on', label: 'Always here', description: 'Whatever the general setting' },
    { value: 'off', label: 'Never here', description: 'Only your instructions' },
  ];
}
