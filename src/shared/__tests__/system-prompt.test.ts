import { describe, expect, it } from 'vitest';

import { joinInstructions, projectPromptMode, resolveSystemPrompt, usesClaudeCodePrompt } from '../system-prompt';
import { DEFAULT_CONFIG } from '../types';

describe("Claude Code's system prompt", () => {
  it('is used by default in a git repository, and not elsewhere', () => {
    expect(DEFAULT_CONFIG.claudeCodePrompt).toBe('auto');
    expect(usesClaudeCodePrompt('auto', true)).toBe(true);
    expect(usesClaudeCodePrompt('auto', false)).toBe(false);
  });

  it('is used in every folder when always, and in none when never', () => {
    expect([usesClaudeCodePrompt('on', true), usesClaudeCodePrompt('on', false)]).toEqual([true, true]);
    expect([usesClaudeCodePrompt('off', true), usesClaudeCodePrompt('off', false)]).toEqual([false, false]);
  });

  it("follows a project's own choice over the general one, and the general one when it has none", () => {
    expect(projectPromptMode('auto', { claudeCodePrompt: 'off' })).toBe('off');
    expect(projectPromptMode('off', { claudeCodePrompt: 'on' })).toBe('on');
    expect(projectPromptMode('off', { instructions: 'only these' })).toBe('off');
    expect(projectPromptMode('on', undefined)).toBe('on');
  });
});

describe('the instructions', () => {
  it('are the general ones, then the project\'s, each trimmed', () => {
    expect(joinInstructions('  answer in French \n', '\n keep commits short ')).toBe('answer in French\n\nkeep commits short');
  });

  it('leave out an empty one', () => {
    expect(joinInstructions('', 'only the project\'s')).toBe('only the project\'s');
    expect(joinInstructions('only the general', '   ')).toBe('only the general');
    expect(joinInstructions(' ', undefined)).toBe('');
  });
});

describe('what a discussion starts with', () => {
  it('in a git repository, by default: Claude Code\'s prompt and no instructions', () => {
    expect(resolveSystemPrompt({ claudeCodePrompt: 'auto', instructions: '', project: undefined }, true))
      .toEqual({ claudeCodePrompt: true, instructions: '' });
  });

  it('in a project that turns it off, with both instructions: no prompt, both instructions', () => {
    expect(resolveSystemPrompt({ claudeCodePrompt: 'auto', instructions: 'general', project: { claudeCodePrompt: 'off', instructions: 'project' } }, true))
      .toEqual({ claudeCodePrompt: false, instructions: 'general\n\nproject' });
  });
});
