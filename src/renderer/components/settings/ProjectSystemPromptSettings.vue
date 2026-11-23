<script setup lang="ts">
/**
 * A project's own say in what Claude is told (@shared/system-prompt):
 * Claude Code's system prompt used here or not whatever the general setting,
 * and instructions told after the general ones. Saved as they change, as the
 * rest of a project's page: the choice at once, the instructions once their
 * box is left.
 *
 * "As in general" says what the general setting comes to in this folder,
 * which for "In git repositories" is git's answer about it.
 */

import { computed, ref, watch } from 'vue';

import { usesClaudeCodePrompt } from '@shared/system-prompt';

import { useMcpStore } from '../../stores/mcp';
import { useSettingsStore } from '../../stores/settings';
import { logger } from '../../utils/logger';
import SystemPromptFields from './SystemPromptFields.vue';
import { projectPromptModes, type ProjectPromptMode } from './prompt-modes';

const mcpStore = useMcpStore();
const settingsStore = useSettingsStore();

/** Whether the project's folder is a git repository; null until git has said. */
const isGitRepository = ref<boolean | null>(null);
const instructions = ref('');
const error = ref<string | null>(null);

const saved = computed(() => (mcpStore.projectDir ? settingsStore.config.projectSystemPrompts[mcpStore.projectDir] : undefined));
const mode = computed<ProjectPromptMode>(() => saved.value?.claudeCodePrompt ?? 'general');
const modeOptions = computed(() =>
  projectPromptModes(
    isGitRepository.value === null ? null : usesClaudeCodePrompt(settingsStore.config.claudeCodePrompt, isGitRepository.value),
  ),
);

async function readRepository(dir: string | null): Promise<void> {
  isGitRepository.value = null;
  if (!dir) return;
  try {
    const status = await window.electron.git.status(dir);
    if (mcpStore.projectDir === dir) isGitRepository.value = status.isGitRepo;
  } catch (err) {
    logger.warn('Failed to read whether the project is a git repository', { error: err });
  }
}

watch(() => mcpStore.projectDir, readRepository, { immediate: true });
watch(() => saved.value?.instructions ?? '', (text) => { instructions.value = text; }, { immediate: true });

async function save(change: Parameters<typeof settingsStore.setProjectSystemPrompt>[1]): Promise<void> {
  const dir = mcpStore.projectDir;
  if (!dir) return;
  error.value = null;
  try {
    await settingsStore.setProjectSystemPrompt(dir, change);
  } catch (err) {
    logger.error("Failed to save the project's instructions", { error: err });
    error.value = "This project's instructions could not be saved.";
  }
}

function chooseMode(choice: ProjectPromptMode): void {
  void save({ claudeCodePrompt: choice === 'general' ? null : choice });
}
</script>

<template>
  <div class="project-system-prompt">
    <h3 class="text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
      Instructions
    </h3>
    <p
      v-if="error"
      class="mb-2 text-xs text-red-700 dark:text-red-300"
      role="alert"
    >
      {{ error }}
    </p>
    <div class="p-3 rounded-lg border border-surface-300 dark:border-surface-600">
      <SystemPromptFields
        v-model:instructions="instructions"
        id-prefix="project-prompt"
        :mode="mode"
        :mode-options="modeOptions"
        instructions-label="Instructions for this project"
        instructions-hint="Told to Claude after the instructions for every discussion, in this project only."
        @update:mode="chooseMode"
        @commit-instructions="save({ instructions: $event })"
      />
    </div>
  </div>
</template>
