<script setup lang="ts">
/**
 * Compact inline tool use indicator displayed in the message stream.
 * Shows tool name, description, and current status as a log-like entry.
 * Clickable — opens tool detail modal via emitted event.
 */

import { computed } from 'vue';

import type { ToolUseInfo } from '@shared/types';

import Icon from '../shared/Icon.vue';
import type { IconName } from '../shared/Icon.vue';
import Spinner from '../shared/Spinner.vue';

interface Props {
  /** Tool use information to display */
  toolUse: ToolUseInfo;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'open-detail', id: string): void;
}>();

const hasDetail = computed(() => !!props.toolUse.input || !!props.toolUse.outputFile);

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
 * Status display configuration
 */
const statusConfig = computed(() => {
  switch (props.toolUse.status) {
    case 'pending':
      return { label: 'Pending', colorClass: 'text-yellow-500 dark:text-yellow-400' };
    case 'approved':
      return { label: 'Approved', colorClass: 'text-blue-500 dark:text-blue-400' };
    case 'executed':
      return { label: 'Done', colorClass: 'text-green-500 dark:text-green-400' };
    case 'rejected':
      return { label: 'Rejected', colorClass: 'text-red-500 dark:text-red-400' };
    case 'failed':
      return { label: 'Failed', colorClass: 'text-red-500 dark:text-red-400' };
    default:
      return { label: '', colorClass: '' };
  }
});

const showSpinner = computed(() => props.toolUse.status === 'pending' || props.toolUse.status === 'approved');
const showCheckIcon = computed(() => props.toolUse.status === 'executed');
const showErrorIcon = computed(() => props.toolUse.status === 'rejected' || props.toolUse.status === 'failed');
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

    <!-- Description -->
    <span class="text-xs text-surface-400 dark:text-surface-500 truncate">
      {{ toolUse.description }}
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
