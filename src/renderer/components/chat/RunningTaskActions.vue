<script setup lang="ts">
/**
 * What can be done to a running task, as the task and tool details both
 * offer it: stop it, and — while its call waits on it in the foreground —
 * send it to the background now instead of when its timeout comes. With the
 * error of the last of these that failed.
 *
 * The caller shows it only while the task runs, so it is never offered for
 * something already finished.
 */

import Button from '../shared/Button.vue';
import Icon from '../shared/Icon.vue';
import Spinner from '../shared/Spinner.vue';

/** The action asked for and not answered yet, if one is. */
export type TaskActionPending = 'stop' | 'background' | null;

withDefaults(defineProps<{
  /** The task runs in the foreground, so it can be sent to the background. */
  canBackground?: boolean;
  pending?: TaskActionPending;
  /** Why the last action failed. */
  error?: string | null;
}>(), {
  canBackground: false,
  pending: null,
  error: null,
});

const emit = defineEmits<{
  (e: 'stop'): void;
  (e: 'background'): void;
}>();
</script>

<template>
  <div class="pt-2 border-t border-surface-200 dark:border-surface-700">
    <div
      v-if="error"
      class="text-xs text-red-500 mb-2 p-2 bg-red-50 dark:bg-red-900/20 rounded-lg"
    >
      {{ error }}
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <Button
        variant="danger"
        size="sm"
        :disabled="pending !== null"
        @click="emit('stop')"
      >
        <Spinner
          v-if="pending === 'stop'"
          size="xs"
          class="mr-1"
        />
        <Icon
          v-else
          name="close"
          size="xs"
          class="mr-1"
        />
        {{ pending === 'stop' ? 'Stopping…' : 'Stop task' }}
      </Button>
      <!-- The call stops waiting and the turn goes on; the task keeps
           running, in the background tasks list. -->
      <Button
        v-if="canBackground"
        variant="secondary"
        size="sm"
        :disabled="pending !== null"
        title="Stop waiting for it: the task keeps running in the background and Claude carries on"
        @click="emit('background')"
      >
        <Spinner
          v-if="pending === 'background'"
          size="xs"
          class="mr-1"
        />
        <Icon
          v-else
          name="chevron-down"
          size="xs"
          class="mr-1"
        />
        {{ pending === 'background' ? 'Sending to background…' : 'Send to background' }}
      </Button>
    </div>
  </div>
</template>
