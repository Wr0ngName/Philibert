<script setup lang="ts">
/**
 * Compact inline tool use indicator displayed in the message stream.
 * Shows tool name, description, and current status as a log-like entry —
 * for a call that ran an agent or a background command, the status of that
 * task.
 * Clickable — opens tool detail modal via emitted event.
 */

import { computed } from 'vue';

import { toolCallLabel } from '@shared/tool-description';
import type { ToolUseInfo } from '@shared/types';

import { useChatStore } from '../../stores/chat';
import { rowStatusDisplay } from '../../utils/row-status';
import Icon from '../shared/Icon.vue';
import type { IconName } from '../shared/Icon.vue';
import Spinner from '../shared/Spinner.vue';

interface Props {
  /** Tool use information to display */
  toolUse: ToolUseInfo;
  /** When the call's row was added; the start time of a task record that has none. */
  timestamp: number;
  /** Number of sub-agent actions spawned by this tool (transitive). 0 means no sub-agent. */
  childCount?: number;
  /** Whether the sub-agent group is currently expanded */
  isExpanded?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  childCount: 0,
  isExpanded: false,
});

const emit = defineEmits<{
  (e: 'open-detail', id: string): void;
  (e: 'toggle-expand', id: string): void;
}>();

const chatStore = useChatStore();

const hasChildren = computed(() => props.childCount > 0);

function handleToggleExpand(event: Event) {
  event.stopPropagation();
  const id = props.toolUse.toolUseBlockId || props.toolUse.actionId;
  emit('toggle-expand', id);
}

const hasDetail = computed(() => !!props.toolUse.input || !!props.toolUse.outputFile);

const label = computed(() => toolCallLabel(props.toolUse));

function handleClick() {
  if (hasDetail.value) {
    emit('open-detail', props.toolUse.toolUseBlockId || props.toolUse.actionId);
  }
}

/**
 * Map tool names to appropriate icons
 */
const toolIcon = computed((): IconName => {
  const name = props.toolUse.toolName.toLowerCase();

  if (name.includes('bash') || name.includes('terminal')) return 'terminal';
  if (name.includes('edit')) return 'edit';
  if (name.includes('write') || name.includes('create')) return 'document';
  if (name.includes('read') || name.includes('glob') || name.includes('grep')) return 'eye';
  if (name.includes('code')) return 'code';

  return 'terminal';
});

/**
 * The task this call stands for — the agent it ran, or its command running
 * in the background. The call is that task's one row in the discussion, so
 * the row says how the task stands: the call itself is done as soon as it
 * has launched the task, and "Done" there would be wrong for as long as the
 * task runs.
 */
const task = computed(() => chatStore.taskForToolCall(props.toolUse, props.timestamp));

const status = computed(() => rowStatusDisplay(task.value?.status ?? props.toolUse.status));

/** What the task reported when it ended, as a task's own row shows it. */
const summary = computed(() =>
  task.value?.status === 'completed' ? task.value.summary : undefined,
);
</script>

<template>
  <div
    :class="[
      'flex items-center gap-2 py-1.5 px-3 animate-fade-in tool-use-entry rounded transition-colors',
      hasDetail ? 'cursor-pointer hover:bg-surface-100 dark:hover:bg-surface-700/50' : '',
    ]"
    :role="hasDetail ? 'button' : undefined"
    :tabindex="hasDetail ? 0 : undefined"
    :title="hasDetail ? 'Click to view tool details' : undefined"
    @click="handleClick"
    @keydown.enter="handleClick"
  >
    <!-- Tool icon -->
    <Icon
      :name="toolIcon"
      size="xs"
      class="text-surface-400 dark:text-surface-500 shrink-0"
    />

    <!-- Tool name -->
    <span class="text-xs font-medium text-surface-500 dark:text-surface-400 shrink-0">
      {{ toolUse.toolName }}
    </span>

    <!-- What the call is: a command's or an agent's own name for its work -->
    <span
      v-if="label"
      class="text-xs text-surface-400 dark:text-surface-500 truncate"
    >
      {{ label }}
    </span>

    <!-- Summary snippet (completed task) -->
    <span
      v-if="summary"
      class="text-xs text-surface-400 dark:text-surface-500 truncate max-w-[200px] hidden sm:inline"
      :title="summary"
    >
      — {{ summary }}
    </span>

    <!-- Expand/collapse toggle for sub-agent activity -->
    <button
      v-if="hasChildren"
      type="button"
      :class="[
        'flex items-center gap-1 px-1.5 py-0.5 rounded text-xs shrink-0 transition-colors',
        'text-surface-500 dark:text-surface-400',
        'hover:bg-surface-200 dark:hover:bg-surface-700',
      ]"
      :title="isExpanded ? 'Collapse sub-agent actions' : 'Expand sub-agent actions'"
      @click="handleToggleExpand"
      @keydown.enter.stop="handleToggleExpand"
    >
      <Icon
        :name="isExpanded ? 'chevron-down' : 'chevron-right'"
        size="xs"
      />
      <span>{{ childCount }} action{{ childCount === 1 ? '' : 's' }}</span>
    </button>

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
      <Icon
        v-if="hasDetail"
        name="chevron-right"
        size="xs"
        class="text-surface-300 dark:text-surface-600"
      />
    </div>
  </div>
</template>

<style scoped>
.tool-use-entry {
  border-left: 2px solid var(--tw-border-opacity, 1);
  border-color: rgb(163 163 163 / 0.3);
  margin-left: 0.75rem;
}

:root.dark .tool-use-entry,
.dark .tool-use-entry {
  border-color: rgb(82 82 82 / 0.5);
}
</style>
