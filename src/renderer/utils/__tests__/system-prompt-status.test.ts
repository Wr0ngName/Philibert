/**
 * Whether a discussion runs on the system prompt the settings ask for: from
 * what Claude Code recorded for it, the settings' prompt in its folder, and
 * what the user chose to go on under.
 */

import { describe, expect, it } from 'vitest';

import { systemPromptStatus, type SystemPromptFacts } from '../system-prompt-status';

const FRENCH = { claudeCodePrompt: false, instructions: 'Answer in French.' };
const GERMAN = { claudeCodePrompt: false, instructions: 'Answer in German.' };
const CLAUDE_CODE_FRENCH = { claudeCodePrompt: true, instructions: 'Answer in French.' };

const facts = (over: Partial<SystemPromptFacts>): SystemPromptFacts =>
  ({ started: true, recorded: FRENCH, current: FRENCH, keptUnder: undefined, ...over });

describe('a discussion', () => {
  it('not started is on the settings: its first message starts it on them, whatever was recorded', () => {
    expect(systemPromptStatus(facts({ started: false, recorded: undefined, current: GERMAN }))).toEqual({ kind: 'current' });
  });

  it('started before what it started on was kept is legacy, whatever the settings', () => {
    expect(systemPromptStatus(facts({ recorded: undefined }))).toEqual({ kind: 'legacy' });
    expect(systemPromptStatus(facts({ recorded: undefined, current: null }))).toEqual({ kind: 'legacy' });
  });

  it('on what the settings ask for is on them', () => {
    expect(systemPromptStatus(facts({}))).toEqual({ kind: 'current' });
  });

  it('differs when the instructions changed, or Claude Code\'s prompt alone', () => {
    expect(systemPromptStatus(facts({ current: GERMAN }))).toEqual({ kind: 'differs', recorded: FRENCH, current: GERMAN });
    expect(systemPromptStatus(facts({ current: CLAUDE_CODE_FRENCH }))).toEqual({ kind: 'differs', recorded: FRENCH, current: CLAUDE_CODE_FRENCH });
  });

  it('is not said to differ while the settings are not known yet', () => {
    expect(systemPromptStatus(facts({ current: null }))).toEqual({ kind: 'current' });
  });

  it('gone on with under the settings, is not said to differ again until they change', () => {
    expect(systemPromptStatus(facts({ current: GERMAN, keptUnder: GERMAN }))).toEqual({ kind: 'current' });
    expect(systemPromptStatus(facts({ current: CLAUDE_CODE_FRENCH, keptUnder: GERMAN })))
      .toEqual({ kind: 'differs', recorded: FRENCH, current: CLAUDE_CODE_FRENCH });
  });
});
