<script setup lang="ts">
/**
 * Background Task Panel - displays only running background tasks.
 * Completed/failed/stopped tasks are shown inline in the chat stream instead.
 * Clicking a task row opens the detail modal.
 *
 * A row reads the way the CLI's does — the agent's type, what it is doing
 * right now, how long it has run and the tokens it has used — and the tasks
 * an agent started sit under that agent.
 */

import { computed, ref } from 'vue';

import type { BackgroundTask } from '@shared/types';

import { useNowTicker } from '../../composables/useNowTicker';
import { formatTaskDuration } from '../../utils/task-duration';
import { taskTreeRows } from '../../utils/task-tree';
import { formatTokenCount } from '../../utils/token-count';
import Icon from '../shared/Icon.vue';
import Spinner from '../shared/Spinner.vue';

interface Props {
  /** List of currently running background tasks */
  tasks: BackgroundTask[];
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'open-detail', taskId: string): void;
}>();

// A clock only while there are tasks to show a duration for.
const now = useNowTicker(() => props.tasks.length > 0);

const collapsed = ref(false);

const rows = computed(() => taskTreeRows(props.tasks));

function toggleCollapsed(): void {
  collapsed.value = !collapsed.value;
}

/** What the row says the task is doing: its live activity, or what it is for. */
function rowText(task: BackgroundTask): string {
  return task.activity ?? task.description;
}

/** "8m 0s · ↓ 160.8k tokens", as the CLI's row ends. */
function rowStats(task: BackgroundTask): string {
  const parts = [formatTaskDuration(task, now.value)];
  if (task.totalTokens) parts.push(`↓ ${formatTokenCount(task.totalTokens)} tokens`);
  return parts.join(' · ');
}
</script>

<template>
  <div
    v-if="tasks.length > 0"
    class="background-task-panel"
  >
    <!-- Header -->
    <button
      type="button"
      class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-100 dark:hover:bg-surface-700/50 transition-colors"
      :class="collapsed ? '' : 'border-b border-surface-200 dark:border-surface-700'"
      :title="collapsed ? 'Expand background tasks' : 'Collapse background tasks'"
      :aria-expanded="!collapsed"
      @click="toggleCollapsed"
    >
      <Icon
        :name="collapsed ? 'chevron-right' : 'chevron-down'"
        size="xs"
        class="text-surface-500 dark:text-surface-400 shrink-0"
      />
      <span class="text-xs font-medium text-surface-600 dark:text-surface-400">
        Background Tasks
        <span class="ml-1 text-blue-500">
          ({{ tasks.length }} running)
        </span>
      </span>
    </button>

    <!-- Running task list -->
    <div
      v-show="!collapsed"
      class="max-h-48 overflow-y-auto"
    >
      <div
        v-for="row in rows"
        :key="row.task.id"
        class="task-item cursor-pointer hover:bg-surface-100 dark:hover:bg-surface-700/50 transition-colors"
        :style="row.depth > 0 ? { paddingLeft: 0.75 + row.depth * 1.25 + 'rem' } : undefined"
        role="button"
        tabindex="0"
        :title="row.task.description"
        :data-depth="row.depth"
        @click="emit('open-detail', row.task.id)"
        @keydown.enter="emit('open-detail', row.task.id)"
      >
        <div class="flex items-center gap-2 flex-1 min-w-0">
          <!-- Started by the agent above. -->
          <span
            v-if="row.depth > 0"
            class="text-xs text-surface-400 dark:text-surface-500 shrink-0"
            aria-hidden="true"
          >↳</span>
          <Icon
            :name="row.task.taskType === 'agent' ? 'cpu' : 'terminal'"
            size="xs"
            :class="[
              'shrink-0',
              row.task.taskType === 'agent'
                ? 'text-purple-500 dark:text-purple-400'
                : 'text-surface-500 dark:text-surface-400',
            ]"
            :title="row.task.taskType === 'agent' ? 'Sub-agent' : 'Background command'"
          />
          <Spinner
            size="xs"
            class="text-blue-500 shrink-0"
          />
          <span
            v-if="row.task.taskType === 'agent' && row.task.agentType"
            class="text-xs font-mono font-medium text-purple-600 dark:text-purple-400 shrink-0"
          >{{ row.task.agentType }}</span>
          <span class="text-xs text-surface-700 dark:text-surface-300 truncate">
            {{ rowText(row.task) }}
          </span>
        </div>
        <span class="text-xs text-surface-400 shrink-0 tabular-nums">
          {{ rowStats(row.task) }}
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
