<script setup lang="ts">
/**
 * Task List Panel — displays the model's SDK-managed todo list, reconstructed
 * client-side from TaskCreate / TaskUpdate / TaskList tool calls. Sticky at
 * the top of the message area so the current plan stays visible while the
 * user scrolls through activity.
 *
 * Collapsible; auto-collapses on first render when there are more than 5 items.
 * Deleted items are filtered upstream in the store.
 */

import { computed, ref, watch } from 'vue';

import type { TaskListItem } from '@shared/types';

import Icon from '../shared/Icon.vue';
import Spinner from '../shared/Spinner.vue';

interface Props {
  items: TaskListItem[];
}

const props = defineProps<Props>();

const AUTO_COLLAPSE_THRESHOLD = 5;

const collapsed = ref(false);
let userInteracted = false;

// Auto-collapse when the list first grows past the threshold, unless the user
// has explicitly toggled the panel — then their choice sticks.
watch(
  () => props.items.length,
  (count, prev) => {
    if (userInteracted) return;
    if (prev === undefined || prev <= AUTO_COLLAPSE_THRESHOLD) {
      collapsed.value = count > AUTO_COLLAPSE_THRESHOLD;
    }
  },
  { immediate: true },
);

function toggleCollapsed(): void {
  userInteracted = true;
  collapsed.value = !collapsed.value;
}

const completedCount = computed(() =>
  props.items.filter(t => t.status === 'completed').length
);

const totalCount = computed(() => props.items.length);

function itemIcon(item: TaskListItem): 'check-circle' | 'chevron-right' {
  return item.status === 'completed' ? 'check-circle' : 'chevron-right';
}
</script>

<template>
  <div
    v-if="items.length > 0"
    class="task-list-panel"
  >
    <!-- Header -->
    <button
      type="button"
      class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-100 dark:hover:bg-surface-700/50 transition-colors"
      :class="collapsed ? '' : 'border-b border-surface-200 dark:border-surface-700'"
      :title="collapsed ? 'Expand task list' : 'Collapse task list'"
      :aria-expanded="!collapsed"
      @click="toggleCollapsed"
    >
      <Icon
        :name="collapsed ? 'chevron-right' : 'chevron-down'"
        size="xs"
        class="text-surface-500 dark:text-surface-400 shrink-0"
      />
      <span class="text-xs font-medium text-surface-600 dark:text-surface-400">
        Task List
        <span class="ml-1 text-surface-500 dark:text-surface-400">
          ({{ completedCount }}/{{ totalCount }} done)
        </span>
      </span>
    </button>

    <!-- Task list body -->
    <div
      v-show="!collapsed"
      class="max-h-48 overflow-y-auto"
    >
      <div
        v-for="item in items"
        :key="item.id"
        class="task-list-row"
        :class="item.status === 'completed' ? 'opacity-60' : ''"
      >
        <!-- Status marker -->
        <span class="shrink-0 flex items-center justify-center w-4 h-4">
          <Spinner
            v-if="item.status === 'in_progress'"
            size="xs"
            class="text-primary-500"
          />
          <Icon
            v-else
            :name="itemIcon(item)"
            size="xs"
            :class="
              item.status === 'completed'
                ? 'text-green-500 dark:text-green-400'
                : 'text-surface-400 dark:text-surface-500'
            "
          />
        </span>

        <!-- Subject + optional activeForm hint -->
        <span
          class="text-xs truncate"
          :class="
            item.status === 'completed'
              ? 'line-through text-surface-500 dark:text-surface-400'
              : 'text-surface-700 dark:text-surface-300'
          "
        >
          {{ item.subject }}
          <span
            v-if="item.status === 'in_progress' && item.activeForm"
            class="ml-1 text-surface-400 dark:text-surface-500"
          >
            — {{ item.activeForm }}
          </span>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "../../assets/styles/main.css";
.task-list-panel {
  @apply bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-lg overflow-hidden;
}

.task-list-row {
  @apply flex items-center gap-2 px-3 py-1.5 border-b border-surface-100 dark:border-surface-700/50 last:border-b-0;
}
</style>
