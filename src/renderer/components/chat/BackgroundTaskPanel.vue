<script setup lang="ts">
/**
 * Background Task Panel - displays only running background tasks.
 * Completed/failed/stopped tasks are shown inline in the chat stream instead.
 * Clicking a task row opens the detail modal.
 */

import { onBeforeUnmount, ref, watch } from 'vue';

import type { BackgroundTask } from '@shared/types';

import Spinner from '../shared/Spinner.vue';

interface Props {
  /** List of currently running background tasks */
  tasks: BackgroundTask[];
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'open-detail', taskId: string): void;
}>();

// Reactive clock that ticks every second for live duration display
const now = ref(Date.now());
let tickTimer: ReturnType<typeof setInterval> | null = null;

function startTick(): void {
  if (!tickTimer) {
    tickTimer = setInterval(() => { now.value = Date.now(); }, 1000);
  }
}

function stopTick(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

// Only tick while there are tasks to display
watch(
  () => props.tasks.length,
  (count) => {
    if (count > 0) {
      startTick();
    } else {
      stopTick();
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => stopTick());

function formatDuration(task: BackgroundTask): string {
  const endTime = task.completedAt || now.value;
  const durationMs = endTime - task.startedAt;
  const seconds = Math.floor(durationMs / 1000);

  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}
</script>

<template>
  <div
    v-if="tasks.length > 0"
    class="background-task-panel"
  >
    <!-- Header -->
    <div class="flex items-center px-3 py-2 border-b border-surface-200 dark:border-surface-700">
      <span class="text-xs font-medium text-surface-600 dark:text-surface-400">
        Background Tasks
        <span class="ml-1 text-blue-500">
          ({{ tasks.length }} running)
        </span>
      </span>
    </div>

    <!-- Running task list -->
    <div class="max-h-40 overflow-y-auto">
      <div
        v-for="task in tasks"
        :key="task.id"
        class="task-item cursor-pointer hover:bg-surface-100 dark:hover:bg-surface-700/50 transition-colors"
        role="button"
        tabindex="0"
        title="Click to view task details"
        @click="emit('open-detail', task.id)"
        @keydown.enter="emit('open-detail', task.id)"
      >
        <div class="flex items-center gap-2 flex-1 min-w-0">
          <Spinner
            size="xs"
            class="text-blue-500 shrink-0"
          />
          <span class="text-xs text-surface-700 dark:text-surface-300 truncate">
            {{ task.description }}
          </span>
        </div>
        <span class="text-xs text-surface-400 shrink-0">
          {{ formatDuration(task) }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "../../assets/styles/main.css";
.background-task-panel {
  @apply bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-lg overflow-hidden;
}

.task-item {
  @apply flex items-center gap-2 px-3 py-2 border-b border-surface-100 dark:border-surface-700/50 last:border-b-0;
}
</style>
