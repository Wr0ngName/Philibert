<script setup lang="ts">
/**
 * Resource Limit Warning - displays when max concurrent conversations reached
 */

import { computed } from 'vue';

import Icon from '../shared/Icon.vue';

interface Props {
  /** Current number of open sessions */
  activeCount: number;
  /** Maximum allowed concurrent queries */
  maxCount: number;
  /** Number of conversations currently processing a query */
  processingCount: number;
}

const props = defineProps<Props>();

const isAtLimit = computed(() => props.activeCount >= props.maxCount);
const isNearLimit = computed(() => props.activeCount >= props.maxCount - 1);
const shouldShow = computed(() => props.processingCount > 0 || isNearLimit.value);

const statusClass = computed(() => {
  if (isAtLimit.value) return 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800';
  if (isNearLimit.value) return 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800';
  return 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800';
});

const iconClass = computed(() => {
  if (isAtLimit.value) return 'text-red-500 dark:text-red-400';
  if (isNearLimit.value) return 'text-yellow-500 dark:text-yellow-400';
  return 'text-blue-500 dark:text-blue-400';
});

const textClass = computed(() => {
  if (isAtLimit.value) return 'text-red-700 dark:text-red-300';
  if (isNearLimit.value) return 'text-yellow-700 dark:text-yellow-300';
  return 'text-blue-700 dark:text-blue-300';
});

const statusText = computed(() => {
  if (isAtLimit.value) {
    return 'Resource limit reached - cannot start new conversations';
  }
  if (isNearLimit.value) {
    return 'Approaching resource limit';
  }
  return `${props.processingCount} active conversation${props.processingCount !== 1 ? 's' : ''}`;
});
</script>

<template>
  <div
    v-if="shouldShow"
    :class="[
      statusClass,
      'flex items-center gap-2 px-3 py-2 border rounded-lg text-sm'
    ]"
  >
    <Icon
      name="cpu"
      size="sm"
      :class="iconClass"
    />
    <span :class="textClass">
      {{ statusText }}
    </span>
    <span class="text-surface-500 dark:text-surface-400 ml-auto">
      {{ activeCount }}/{{ maxCount }}
    </span>
  </div>
</template>
