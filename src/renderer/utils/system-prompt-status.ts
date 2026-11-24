/**
 * Whether a discussion runs on the system prompt the settings ask for.
 *
 * Claude Code records a discussion's system prompt on its first request and
 * sends that record for good: on every resume, whatever the settings say
 * since, and through compaction (@shared/system-prompt). So a discussion
 * started before the settings changed runs on, on its own prompt — which the
 * user is told, to go on with it or start a new one when it suits them.
 */

import { sameSystemPrompt, type SystemPromptChoice } from '@shared/system-prompt';

export type SystemPromptStatus =
  /** On the settings' prompt, or not started: its first message starts it on them. */
  | { kind: 'current' }
  /** Started before the app kept what it was started on: not known. */
  | { kind: 'legacy' }
  /** On a prompt the settings no longer ask for. */
  | { kind: 'differs'; recorded: SystemPromptChoice; current: SystemPromptChoice };

export interface SystemPromptFacts {
  /** Whether the discussion has a Claude Code session: whether it was started. */
  started: boolean;
  /** What Claude Code recorded for it (Conversation.recordedSystemPrompt). */
  recorded: SystemPromptChoice | undefined;
  /** What the settings ask for in its folder; null until known. */
  current: SystemPromptChoice | null;
  /** The settings' prompt the user chose to go on under (Conversation.systemPromptKeptUnder). */
  keptUnder: SystemPromptChoice | undefined;
}

export function systemPromptStatus({ started, recorded, current, keptUnder }: SystemPromptFacts): SystemPromptStatus {
  if (!started) return { kind: 'current' };
  if (!recorded) return { kind: 'legacy' };
  if (!current || sameSystemPrompt(recorded, current)) return { kind: 'current' };
  // Gone on with under these very settings: said again only once they change.
  if (keptUnder && sameSystemPrompt(keptUnder, current)) return { kind: 'current' };
  return { kind: 'differs', recorded, current };
}
