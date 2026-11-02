<script setup lang="ts">
/**
 * Where a task, an agent or a tool call came from, for their detail views:
 * the agent that started it — its type, what it is for, and how it stands,
 * which opens its own details — or the main conversation.
 *
 * Said even when that agent has finished. Its work can outlive it: a command
 * an agent left running in the background carries on after the agent has
 * replied, and without this nothing said whose command it was.
 */

import { computed } from 'vue';

import type { BackgroundTask } from '@shared/types';

import Icon from '../shared/Icon.vue';

interface Props {
  /**
   * 'agent' when an agent started it, 'main' when the main conversation did.
   * Null when it is not known, and nothing is shown.
   */
  origin: 'agent' | 'main' | null;
  /** The agent, when an agent started it and that agent is known here. */
  agent?: BackgroundTask | null;
}

const props = withDefaults(defineProps<Props>(), { agent: null });

const emit = defineEmits<{
  /** Show the agent's own details. */
  (e: 'open-agent', taskId: string): void;
}>();

const STATUS: Record<BackgroundTask['status'], string> = {
  running: 'running',
  completed: 'finished',
  failed: 'failed',
  stopped: 'stopped',
};

const agentStatus = computed(() => (props.agent ? STATUS[props.agent.status] : ''));
</script>

<template>
  <div
    v-if="origin"
    class="started-by flex items-center gap-1.5 text-xs text-surface-500 dark:text-surface-400 min-w-0"
  >
    <template v-if="origin === 'main'">
      <Icon
        name="chat"
        size="xs"
      />
      <span>Started by the main conversation</span>
    </template>
    <button
      v-else-if="agent"
      type="button"
      class="inline-flex items-center gap-1 min-w-0 text-purple-600 dark:text-purple-400 hover:underline"
      :title="`Show the agent that started this: ${agent.description}`"
      @click="emit('open-agent', agent.id)"
    >
      <Icon
        name="cpu"
        size="xs"
      />
      <span class="shrink-0">Started by {{ agent.agentType ?? 'an agent' }}</span>
      <span class="truncate text-surface-600 dark:text-surface-300">— {{ agent.description }}</span>
      <span class="shrink-0 text-surface-500 dark:text-surface-400">({{ agentStatus }})</span>
    </button>
    <template v-else>
      <Icon
        name="cpu"
        size="xs"
      />
      <span>Started by an agent</span>
    </template>
  </div>
</template>
