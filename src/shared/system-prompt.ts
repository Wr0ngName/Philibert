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
 * The CLI records a discussion's system prompt on its first request and keeps
 * sending that record, on resume too, until the discussion is compacted
 * (`systemPromptSnapshot`, on by default where the account has it). A change
 * here applies to discussions started after it.
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
