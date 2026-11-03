<script setup lang="ts">
/**
 * An agent, named as the detail views name one: its type, what it is for and
 * how it stands. Clicking it opens the agent's own details.
 */

import { computed } from 'vue';

import type { BackgroundTask } from '@shared/types';

import Icon from '../shared/Icon.vue';

interface Props {
  agent: BackgroundTask;
  /** Words before the agent's type, as in "Started by general-purpose". */
  prefix?: string;
}

const props = withDefaults(defineProps<Props>(), { prefix: '' });

const emit = defineEmits<{
  /** Show the agent's own details. */
  (e: 'open', taskId: string): void;
}>();

const STATUS: Record<BackgroundTask['status'], string> = {
  running: 'running',
  completed: 'finished',
  failed: 'failed',
  stopped: 'stopped',
};

const name = computed(() =>
  props.prefix
    ? `${props.prefix} ${props.agent.agentType ?? 'an agent'}`
    : props.agent.agentType ?? 'Agent',
);
</script>

<template>
  <button
    type="button"
    class="agent-link inline-flex items-center gap-1 min-w-0 max-w-full text-purple-600 dark:text-purple-400 hover:underline"
    :title="`Show the agent's details: ${agent.description} (${agent.id})`"
    @click="emit('open', agent.id)"
  >
    <Icon
      name="cpu"
      size="xs"
    />
    <span class="shrink-0">{{ name }}</span>
    <span class="truncate text-surface-600 dark:text-surface-300">— {{ agent.description }}</span>
    <span class="shrink-0 text-surface-500 dark:text-surface-400">({{ STATUS[agent.status] }})</span>
  </button>
</template>
