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

import type { BackgroundTask } from '@shared/types';

import AgentLink from './AgentLink.vue';
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

withDefaults(defineProps<Props>(), { agent: null });

const emit = defineEmits<{
  /** Show the agent's own details. */
  (e: 'open-agent', taskId: string): void;
}>();
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
    <AgentLink
      v-else-if="agent"
      :agent="agent"
      prefix="Started by"
      @open="emit('open-agent', $event)"
    />
    <template v-else>
      <Icon
        name="cpu"
        size="xs"
      />
      <span>Started by an agent</span>
    </template>
  </div>
</template>
