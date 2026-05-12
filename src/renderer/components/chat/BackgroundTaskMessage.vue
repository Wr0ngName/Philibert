<script setup lang="ts">
/**
 * Inline background task indicator displayed in the message stream.
 * Clickable — opens task detail modal via emitted event.
 */

import { computed } from 'vue';

import type { BackgroundTaskInfo } from '@shared/types';

import Icon from '../shared/Icon.vue';
import Spinner from '../shared/Spinner.vue';

interface Props {
  backgroundTask: BackgroundTaskInfo;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'open-detail', taskId: string): void;
}>();

const statusConfig = computed(() => {
  switch (props.backgroundTask.status) {
    case 'running':
      return { label: 'Running', colorClass: 'text-blue-500 dark:text-blue-400' };
    case 'completed':
      return { label: 'Done', colorClass: 'text-green-500 dark:text-green-400' };
    case 'failed':
      return { label: 'Failed', colorClass: 'text-red-500 dark:text-red-400' };
    case 'stopped':
      return { label: 'Stopped', colorClass: 'text-yellow-500 dark:text-yellow-400' };
    default:
      return { label: '', colorClass: '' };
  }
});

const showSpinner = computed(() => props.backgroundTask.status === 'running');
const showCheckIcon = computed(() => props.backgroundTask.status === 'completed');
const showErrorIcon = computed(() =>
  props.backgroundTask.status === 'failed' || props.backgroundTask.status === 'stopped'
);
</script>

<template>
  <div
    class="flex items-center gap-2 py-1.5 px-3 animate-fade-in task-entry cursor-pointer
           hover:bg-surface-100 dark:hover:bg-surface-700/50 rounded transition-colors"
    role="button"
    tabindex="0"
    title="Click to view task details"
    @click="emit('open-detail', backgroundTask.taskId)"
    @keydown.enter="emit('open-detail', backgroundTask.taskId)"
  >
    <!-- Task icon -->
    <Icon
      name="cpu"
      size="xs"
      class="text-surface-400 dark:text-surface-500 shrink-0"
    />

    <!-- Label -->
    <span class="text-xs font-medium text-surface-500 dark:text-surface-400 shrink-0">
      Task
    </span>

    <!-- Description -->
    <span class="text-xs text-surface-400 dark:text-surface-500 truncate">
      {{ backgroundTask.description }}
    </span>

    <!-- Summary snippet (completed) -->
    <span
      v-if="backgroundTask.summary && backgroundTask.status === 'completed'"
      class="text-xs text-surface-400 dark:text-surface-500 truncate max-w-[200px] hidden sm:inline"
      :title="backgroundTask.summary"
    >
      — {{ backgroundTask.summary }}
    </span>

    <!-- Status indicator -->
    <div class="ml-auto flex items-center gap-1 shrink-0">
      <Spinner
        v-if="showSpinner"
        size="xs"
        class="text-primary-500"
      />
      <Icon
        v-else-if="showCheckIcon"
        name="check-circle"
        size="xs"
        class="text-green-500 dark:text-green-400"
      />
      <Icon
        v-else-if="showErrorIcon"
        name="x-circle"
        size="xs"
        class="text-red-500 dark:text-red-400"
      />
      <span :class="['text-xs', statusConfig.colorClass]">
        {{ statusConfig.label }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.task-entry {
  border-left: 2px solid var(--tw-border-opacity, 1);
  border-color: rgb(163 163 163 / 0.3);
  margin-left: 0.75rem;
}

:root.dark .task-entry,
.dark .task-entry {
  border-color: rgb(82 82 82 / 0.5);
}
</style>
