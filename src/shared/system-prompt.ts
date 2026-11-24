/**
 * What Claude is told before a discussion's first message: Claude Code's own
 * system prompt or not, and the user's instructions after it.
 *
 * Without Claude Code's prompt the CLI runs on a single line of its own ("You
 * are a Claude agent, built on Anthropic's Claude Agent SDK."): what the SDK
 * sends when no prompt is asked for. With it, Claude has Claude Code's
 * guidance on its tools, git, tasks and answers — made for working on code,
 * so it is used by default in a git repository and not elsewhere.
 *
 * The CLI records a discussion's system prompt on its first request and
 * sends that record from then on: on every resume, whatever the resume asks
 * for, and through a compaction that keeps recent messages; one that
 * summarizes everything records anew the prompt its session started on
 * (`systemPromptSnapshot`, on by default where the account has it; measured
 * against CLI 2.1.280). So a change here applies to discussions started after
 * it. One started before runs on, on its own, and says so
 * (Conversation.recordedSystemPrompt).
 */

/** Whether Claude Code's system prompt is used: in git repositories only, always, or never. */
export const CLAUDE_CODE_PROMPT_MODES = ['auto', 'on', 'off'] as const;
export type ClaudeCodePromptMode = (typeof CLAUDE_CODE_PROMPT_MODES)[number];

/** A project's own: either left out follows the general setting. */
export interface ProjectSystemPrompt {
  /** On or off in this project whatever the general setting says. */
  claudeCodePrompt?: Exclude<ClaudeCodePromptMode, 'auto'>;
  /** Told after the general instructions, in this project only. */
  instructions?: string;
}

/** What a discussion starts with. */
export interface SystemPromptChoice {
  claudeCodePrompt: boolean;
  /** The instructions told after it, '' for none. */
  instructions: string;
}

/** Whether a value, as it crossed IPC or was read back, is a choice. */
export function isSystemPromptChoice(value: unknown): value is SystemPromptChoice {
  if (typeof value !== 'object' || value === null) return false;
  const { claudeCodePrompt, instructions } = value as Record<string, unknown>;
  return typeof claudeCodePrompt === 'boolean' && typeof instructions === 'string';
}

/** Whether two choices tell Claude the same. */
export function sameSystemPrompt(a: SystemPromptChoice, b: SystemPromptChoice): boolean {
  return a.claudeCodePrompt === b.claudeCodePrompt && a.instructions === b.instructions;
}

/** The mode a project runs under: its own if it has one, else the general one. */
export function projectPromptMode(general: ClaudeCodePromptMode, project: ProjectSystemPrompt | undefined): ClaudeCodePromptMode {
  return project?.claudeCodePrompt ?? general;
}

/** Whether a mode uses Claude Code's prompt in a folder that is, or is not, a git repository. */
export function usesClaudeCodePrompt(mode: ClaudeCodePromptMode, isGitRepository: boolean): boolean {
  return mode === 'auto' ? isGitRepository : mode === 'on';
}

/** The general instructions, then the project's: each trimmed, an empty one left out. */
export function joinInstructions(general: string, project: string | undefined): string {
  return [general, project ?? '']
    .map((text) => text.trim())
    .filter(Boolean)
    .join('\n\n');
}

/** What a discussion in a folder starts with, from the settings. */
export function resolveSystemPrompt(
  settings: { claudeCodePrompt: ClaudeCodePromptMode; instructions: string; project: ProjectSystemPrompt | undefined },
  isGitRepository: boolean,
): SystemPromptChoice {
  return {
    claudeCodePrompt: usesClaudeCodePrompt(projectPromptMode(settings.claudeCodePrompt, settings.project), isGitRepository),
    instructions: joinInstructions(settings.instructions, settings.project?.instructions),
  };
}
