<script setup lang="ts">
/**
 * Background task detail modal (equivalent of Ctrl+O in Claude Code CLI).
 * Shows task description, status, duration, summary, error, and output file content.
 */

import { ref, watch, computed } from 'vue';

import type { BackgroundTask } from '@shared/types';

import Icon from '../shared/Icon.vue';
import Modal from '../shared/Modal.vue';
import Spinner from '../shared/Spinner.vue';

interface Props {
  open: boolean;
  task: BackgroundTask | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

// Output file content (lazy-loaded when modal opens)
const outputContent = ref<string | null>(null);
const outputLoading = ref(false);
const outputError = ref<string | null>(null);

// Load output file when modal opens and task has outputFile
watch(
  () => ({ open: props.open, outputFile: props.task?.outputFile }),
  async ({ open, outputFile }) => {
    if (open && outputFile) {
      outputLoading.value = true;
      outputError.value = null;
      outputContent.value = null;
      try {
        outputContent.value = await window.electron.files.read(outputFile);
      } catch (err) {
        outputError.value = err instanceof Error ? err.message : String(err);
      } finally {
        outputLoading.value = false;
      }
    } else if (!open) {
      outputContent.value = null;
      outputError.value = null;
    }
  },
  { immediate: true },
);

const duration = computed(() => {
  if (!props.task) return '';
  const endTime = props.task.completedAt || Date.now();
  const ms = endTime - props.task.startedAt;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
});

const statusDisplay = computed(() => {
  if (!props.task) return { label: '', colorClass: '' };
  switch (props.task.status) {
    case 'running':
      return { label: 'Running', colorClass: 'text-blue-500' };
    case 'completed':
      return { label: 'Completed', colorClass: 'text-green-500' };
    case 'failed':
      return { label: 'Failed', colorClass: 'text-red-500' };
    case 'stopped':
      return { label: 'Stopped', colorClass: 'text-yellow-500' };
    default:
      return { label: '', colorClass: '' };
  }
});
</script>

<template>
  <Modal
    :open="open"
    title="Background Task Details"
    size="3xl"
    @close="emit('close')"
  >
    <div
      v-if="task"
      class="space-y-4"
    >
      <!-- Status & Description -->
      <div class="flex items-start gap-3">
        <div :class="['shrink-0 mt-0.5', statusDisplay.colorClass]">
          <Spinner
            v-if="task.status === 'running'"
            size="sm"
          />
          <Icon
            v-else-if="task.status === 'completed'"
            name="check-circle"
            size="md"
          />
          <Icon
            v-else-if="task.status === 'failed'"
            name="x-circle"
            size="md"
          />
          <Icon
            v-else
            name="stop"
            size="md"
          />
        </div>
        <div class="flex-1 min-w-0">
          <h3 class="text-sm font-semibold text-surface-900 dark:text-surface-100">
            {{ task.description }}
          </h3>
          <div class="flex items-center gap-3 mt-1 text-xs text-surface-500 dark:text-surface-400">
            <span :class="statusDisplay.colorClass">{{ statusDisplay.label }}</span>
            <span>Duration: {{ duration }}</span>
          </div>
        </div>
      </div>

      <!-- Summary -->
      <div
        v-if="task.summary"
        class="bg-surface-50 dark:bg-surface-900 rounded-lg p-3"
      >
        <div class="text-xs font-medium text-surface-500 dark:text-surface-400 mb-1">
          Summary
        </div>
        <div class="text-sm text-surface-800 dark:text-surface-200 whitespace-pre-wrap">
          {{ task.summary }}
        </div>
      </div>

      <!-- Error -->
      <div
        v-if="task.error"
        class="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3"
      >
        <div class="text-xs font-medium text-red-500 mb-1">
          Error
        </div>
        <div class="text-sm text-red-800 dark:text-red-300 whitespace-pre-wrap font-mono">
          {{ task.error }}
        </div>
      </div>

      <!-- Output File Content -->
      <div
        v-if="task.outputFile"
        class="space-y-2"
      >
        <div class="text-xs font-medium text-surface-500 dark:text-surface-400 flex items-center gap-2">
          <Icon
            name="document"
            size="xs"
          />
          <span>Output:</span>
          <span class="font-mono truncate">{{ task.outputFile }}</span>
        </div>

        <div
          v-if="outputLoading"
          class="flex items-center gap-2 p-3 text-xs text-surface-500"
        >
          <Spinner size="xs" />
          Loading output file...
        </div>
        <div
          v-else-if="outputError"
          class="text-xs text-red-500 p-3 bg-red-50 dark:bg-red-900/20 rounded-lg"
        >
          Failed to load output: {{ outputError }}
        </div>
        <div
          v-else-if="outputContent !== null"
          class="bg-surface-50 dark:bg-surface-900 rounded-lg p-3 max-h-80 overflow-y-auto"
        >
          <pre class="text-xs text-surface-800 dark:text-surface-200 whitespace-pre-wrap font-mono">{{ outputContent }}</pre>
        </div>
      </div>
    </div>
  </Modal>
</template>
