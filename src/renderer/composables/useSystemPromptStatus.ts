/**
 * The discussion on screen's system prompt status (systemPromptStatus): what
 * Claude Code recorded for it against what the settings ask for in its
 * folder — whether the folder is a git repository included, as Claude Code's
 * prompt is used by default in one and not elsewhere.
 */

import { computed, ref, watch, type ComputedRef } from 'vue';

import { resolveSystemPrompt } from '@shared/system-prompt';

import { useConversationsStore } from '../stores/conversations';
import { useSettingsStore } from '../stores/settings';
import { logger } from '../utils/logger';
import { systemPromptStatus, type SystemPromptStatus } from '../utils/system-prompt-status';

export function useSystemPromptStatus(): ComputedRef<SystemPromptStatus> {
  const conversationsStore = useConversationsStore();
  const settingsStore = useSettingsStore();

  /** The folder of the discussion on screen: its own once it has one, as its messages are sent in. */
  const folder = computed(() => {
    const id = conversationsStore.currentConversationId;
    return (id && conversationsStore.getConversationWorkingDirectory(id)) || settingsStore.workingDirectory || null;
  });

  /**
   * Whether the folder is a git repository, as git last said; for another
   * folder, or until git has said, not known. Asked again whenever the
   * discussion on screen changes, and as what it runs on does — a session
   * started, a compaction — when the main process has just asked git itself:
   * a folder made a repository meanwhile is then seen to be one.
   */
  const repository = ref<{ folder: string; isRepository: boolean } | null>(null);

  watch(
    [folder, () => conversationsStore.currentConversationId, () => {
      const id = conversationsStore.currentConversationId;
      return id ? conversationsStore.recordedSystemPromptOf(id) : undefined;
    }],
    async ([dir]) => {
      if (!dir) return;
      try {
        const status = await window.electron.git.status(dir);
        if (folder.value === dir) repository.value = { folder: dir, isRepository: status.isGitRepo };
      } catch (err) {
        logger.warn('Failed to read whether the discussion\'s folder is a git repository', { error: err });
      }
    },
    { immediate: true },
  );

  return computed(() => {
    const id = conversationsStore.currentConversationId;
    const dir = folder.value;
    if (!id) return { kind: 'current' };
    const isRepository = repository.value?.folder === dir ? repository.value.isRepository : undefined;
    const { config } = settingsStore;
    const current = dir && isRepository !== undefined
      ? resolveSystemPrompt(
        { claudeCodePrompt: config.claudeCodePrompt, instructions: config.customInstructions, project: config.projectSystemPrompts[dir] },
        isRepository,
      )
      : null;
    return systemPromptStatus({
      started: !!conversationsStore.getSdkSessionId(id),
      recorded: conversationsStore.recordedSystemPromptOf(id),
      current,
      keptUnder: conversationsStore.systemPromptKeptUnderOf(id),
    });
  });
}
