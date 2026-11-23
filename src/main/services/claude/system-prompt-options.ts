/**
 * A discussion's system prompt (@shared/system-prompt), as each way of
 * running Claude Code takes it. Checked against the bundled CLI's requests:
 *
 * - The SDK, given no `systemPrompt`, sends an empty custom one, and the CLI
 *   then runs on its single line of identity. The `claude_code` preset is
 *   Claude Code's whole prompt, `append` after it; a string replaces it,
 *   after the same line of identity.
 * - The CLI, run by itself (channel mode), uses its own prompt unless
 *   `--system-prompt-file` replaces it — an empty one leaves the line of
 *   identity alone, as the SDK's does; `--append-system-prompt-file` adds
 *   after its own. Files rather than the text as an argument: on Windows
 *   node-pty joins the arguments into one command line, where text starting
 *   and ending with a quote is taken as quoted already, and split.
 */

import type { Options } from '@anthropic-ai/claude-agent-sdk';

import { resolveSystemPrompt, type SystemPromptChoice } from '../../../shared/system-prompt';
import type { AppConfig } from '../../../shared/types';

/** What decides a folder's system prompt: the settings, and whether the folder is a git repository. */
export async function systemPromptFor(
  config: Pick<AppConfig, 'claudeCodePrompt' | 'customInstructions' | 'projectSystemPrompts'>,
  workingDirectory: string,
  isRepository: (cwd: string) => Promise<boolean>,
): Promise<SystemPromptChoice> {
  return resolveSystemPrompt(
    {
      claudeCodePrompt: config.claudeCodePrompt,
      instructions: config.customInstructions,
      project: config.projectSystemPrompts[workingDirectory],
    },
    await isRepository(workingDirectory),
  );
}

/** The SDK's `systemPrompt` option; undefined, as before, for no prompt and no instructions. */
export function sdkSystemPrompt(choice: SystemPromptChoice): Options['systemPrompt'] {
  if (choice.claudeCodePrompt) {
    return { type: 'preset', preset: 'claude_code', ...(choice.instructions ? { append: choice.instructions } : {}) };
  }
  return choice.instructions || undefined;
}

/**
 * The CLI's arguments for it, when run by itself, naming the file holding
 * the instructions; null for none, and no file to write.
 */
export function cliSystemPromptArgs(choice: SystemPromptChoice, instructionsFile: string): string[] | null {
  if (choice.claudeCodePrompt) {
    return choice.instructions ? ['--append-system-prompt-file', instructionsFile] : null;
  }
  return ['--system-prompt-file', instructionsFile];
}

/** For the logs: which prompt, and how long the instructions are, never their text. */
export function describeSystemPrompt(choice: SystemPromptChoice): { systemPrompt: string; instructionsLength: number } {
  return { systemPrompt: choice.claudeCodePrompt ? 'claude_code' : 'minimal', instructionsLength: choice.instructions.length };
}
