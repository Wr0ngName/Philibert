<script setup lang="ts" generic="T extends string">
/**
 * What Claude is told before a discussion's first message, as the general
 * settings and a project's page each show it: whether Claude Code's system
 * prompt is used, and the instructions told after it (@shared/system-prompt).
 *
 * The fields only: the general settings keep them until Save, a project's
 * page saves the choice at once and the instructions once the box is left.
 */

import { choiceClasses } from './choice-classes';
import type { PromptModeOption } from './prompt-modes';

defineProps<{
  /** Unique on the page: the fields' ids start with it. */
  idPrefix: string;
  modeOptions: PromptModeOption<T>[];
  mode: T;
  instructions: string;
  instructionsLabel: string;
  instructionsHint: string;
}>();

const emit = defineEmits<{
  (e: 'update:mode', mode: T): void;
  (e: 'update:instructions', instructions: string): void;
  /** The box was left with its text changed. */
  (e: 'commit-instructions', instructions: string): void;
}>();
</script>

<template>
  <div class="system-prompt-fields space-y-4">
    <div>
      <div
        :id="`${idPrefix}-mode-label`"
        class="text-sm font-medium text-surface-700 dark:text-surface-300"
      >
        Claude Code's system prompt
      </div>
      <p class="text-xs text-surface-500 dark:text-surface-400 mt-0.5 mb-2">
        What Claude Code tells Claude about its tools, git, tasks and how to answer — made for working on code.
        Without it, Claude is only told it is a Claude agent. Your CLAUDE.md files are read either way.
      </p>
      <div
        class="grid grid-cols-3 gap-2"
        role="radiogroup"
        :aria-labelledby="`${idPrefix}-mode-label`"
      >
        <button
          v-for="option in modeOptions"
          :key="option.value"
          type="button"
          :class="['system-prompt-mode px-3 py-2 rounded-lg border text-sm transition-colors text-left', choiceClasses(mode === option.value)]"
          role="radio"
          :aria-checked="mode === option.value"
          :data-mode="option.value"
          @click="emit('update:mode', option.value)"
        >
          <div class="font-medium">
            {{ option.label }}
          </div>
          <div class="system-prompt-mode-description text-xs opacity-75">
            {{ option.description }}
          </div>
        </button>
      </div>
    </div>

    <div>
      <label
        :for="`${idPrefix}-instructions`"
        class="block text-sm font-medium text-surface-700 dark:text-surface-300"
      >
        {{ instructionsLabel }}
      </label>
      <p class="text-xs text-surface-500 dark:text-surface-400 mt-0.5 mb-2">
        {{ instructionsHint }}
      </p>
      <textarea
        :id="`${idPrefix}-instructions`"
        :value="instructions"
        rows="4"
        class="input-base font-mono text-xs resize-y"
        placeholder="For example: answer in French, and keep commit messages to one line."
        @input="emit('update:instructions', ($event.target as HTMLTextAreaElement).value)"
        @change="emit('commit-instructions', ($event.target as HTMLTextAreaElement).value)"
      />
    </div>

    <p class="text-xs text-surface-500 dark:text-surface-400">
      Applies to discussions started from then on: one already started may keep what it began with.
    </p>
  </div>
</template>
