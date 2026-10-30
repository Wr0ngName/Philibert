<script setup lang="ts">
/**
 * Inline background task indicator displayed in the message stream.
 * Clickable — opens task detail modal via emitted event.
 *
 * Displays the task as the store tracks it, not the row's stored record: the
 * record is a snapshot from the last save, and showing it is how a row came
 * to say Running long after its task had ended.
 */

import { computed } from 'vue';

import type { BackgroundTaskInfo } from '@shared/types';

import { useChatStore } from '../../stores/chat';
import { rowStatusDisplay } from '../../utils/row-status';
import Icon from '../shared/Icon.vue';
import Spinner from '../shared/Spinner.vue';

interface Props {
  backgroundTask: BackgroundTaskInfo;
  /** When the row was added; the start time of a record that has none. */
  timestamp: number;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'open-detail', taskId: string): void;
}>();

const chatStore = useChatStore();

const task = computed(() =>
  chatStore.taskForRow(chatStore.currentConversationId ?? '', props.backgroundTask, props.timestamp),
);

const status = computed(() => rowStatusDisplay(task.value.status));
</script>

<template>
  <div
    class="flex items-center gap-2 py-1.5 px-3 animate-fade-in task-entry cursor-pointer
           hover:bg-surface-100 dark:hover:bg-surface-700/50 rounded transition-colors"
    role="button"
    tabindex="0"
    title="Click to view task details"
    @click="emit('open-detail', task.id)"
    @keydown.enter="emit('open-detail', task.id)"
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
      {{ task.description }}
    </span>

    <!-- Summary snippet (completed) -->
    <span
      v-if="task.summary && task.status === 'completed'"
      class="text-xs text-surface-400 dark:text-surface-500 truncate max-w-[200px] hidden sm:inline"
      :title="task.summary"
    >
      — {{ task.summary }}
    </span>

    <!-- Status indicator -->
    <div class="ml-auto flex items-center gap-1 shrink-0">
      <Spinner
        v-if="status.mark === 'spinner'"
        size="xs"
        class="text-primary-500"
      />
      <Icon
        v-else-if="status.mark === 'check'"
        name="check-circle"
        size="xs"
        class="text-green-500 dark:text-green-400"
      />
      <Icon
        v-else-if="status.mark === 'error'"
        name="x-circle"
        size="xs"
        class="text-red-500 dark:text-red-400"
      />
      <span :class="['text-xs', status.colorClass]">
        {{ status.label }}
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
