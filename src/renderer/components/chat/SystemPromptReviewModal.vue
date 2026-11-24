<script setup lang="ts">
/**
 * The system prompt the discussion runs on, beside the one the settings ask
 * for now: Claude Code's own prompt or not, and the instructions told after
 * it. A discussion keeps the prompt it started on, so the user decides: go
 * on with it as it is, or start a new discussion on the settings' prompt.
 */

import { computed } from 'vue';

import type { SystemPromptChoice } from '@shared/system-prompt';

import Button from '../shared/Button.vue';
import Modal from '../shared/Modal.vue';

const props = defineProps<{
  open: boolean;
  /** What the discussion runs on. */
  recorded: SystemPromptChoice;
  /** What the settings ask for in its folder. */
  current: SystemPromptChoice;
}>();

const emit = defineEmits<{
  close: [];
  /** Go on with the discussion on its own prompt. */
  keep: [];
  /** Start a new discussion, on the settings' prompt. */
  startNew: [];
}>();

const sides = computed(() => [
  { key: 'recorded', label: 'This discussion', choice: props.recorded },
  { key: 'current', label: 'Settings now', choice: props.current },
]);

const claudeCodePromptChanged = computed(() => props.recorded.claudeCodePrompt !== props.current.claudeCodePrompt);
const instructionsChanged = computed(() => props.recorded.instructions !== props.current.instructions);
</script>

<template>
  <Modal
    :open="open"
    title="System prompt changed"
    size="2xl"
    @close="emit('close')"
  >
    <div class="space-y-4 text-sm text-surface-700 dark:text-surface-200">
      <p>
        A discussion keeps the system prompt it started with: Claude Code sends it on every
        message, whatever the settings say since. This one started before the settings changed.
      </p>

      <div
        class="grid grid-cols-1 sm:grid-cols-2 gap-3"
        data-testid="system-prompt-sides"
      >
        <section
          v-for="side in sides"
          :key="side.key"
          :data-testid="`system-prompt-${side.key}`"
          class="rounded-lg border border-surface-200 dark:border-surface-700 p-3 space-y-2 min-w-0"
        >
          <h3 class="text-xs font-semibold uppercase tracking-wide text-surface-500 dark:text-surface-400">
            {{ side.label }}
          </h3>
          <p :class="{ 'font-semibold text-amber-700 dark:text-amber-300': claudeCodePromptChanged }">
            Claude Code's system prompt: {{ side.choice.claudeCodePrompt ? 'on' : 'off' }}
          </p>
          <div>
            <p
              class="text-xs text-surface-500 dark:text-surface-400 mb-1"
              :class="{ 'font-semibold text-amber-700 dark:text-amber-300': instructionsChanged }"
            >
              Instructions
            </p>
            <pre
              v-if="side.choice.instructions"
              class="whitespace-pre-wrap break-words text-xs rounded bg-surface-50 dark:bg-surface-900 p-2 max-h-64 overflow-auto"
            >{{ side.choice.instructions }}</pre>
            <p
              v-else
              class="text-xs italic text-surface-400 dark:text-surface-500"
            >
              None
            </p>
          </div>
        </section>
      </div>

      <p>
        A new discussion starts on the settings' prompt. This one keeps its history and its
        prompt: finish what is under way here first if you need to.
      </p>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <Button
          variant="secondary"
          data-testid="system-prompt-keep"
          @click="emit('keep')"
        >
          Continue as is
        </Button>
        <Button
          data-testid="system-prompt-start-new"
          @click="emit('startNew')"
        >
          Start a new discussion
        </Button>
      </div>
    </template>
  </Modal>
</template>
