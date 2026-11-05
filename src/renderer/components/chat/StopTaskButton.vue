<script setup lang="ts">
/**
 * Stopping a running task, as the task and tool details both offer it: the
 * button, and the error of a stop that failed. The caller shows it only while
 * the task runs, so it is never offered for something already finished.
 */

import Button from '../shared/Button.vue';
import Icon from '../shared/Icon.vue';
import Spinner from '../shared/Spinner.vue';

withDefaults(defineProps<{
  /** A stop was asked for and has not been answered yet. */
  stopping?: boolean;
  /** Why the last stop failed. */
  stopError?: string | null;
}>(), {
  stopping: false,
  stopError: null,
});

const emit = defineEmits<{
  (e: 'stop'): void;
}>();
</script>

<template>
  <div class="pt-2 border-t border-surface-200 dark:border-surface-700">
    <div
      v-if="stopError"
      class="text-xs text-red-500 mb-2 p-2 bg-red-50 dark:bg-red-900/20 rounded-lg"
    >
      {{ stopError }}
    </div>
    <Button
      variant="danger"
      size="sm"
      :disabled="stopping"
      @click="emit('stop')"
    >
      <Spinner
        v-if="stopping"
        size="xs"
        class="mr-1"
      />
      <Icon
        v-else
        name="close"
        size="xs"
        class="mr-1"
      />
      {{ stopping ? 'Stopping…' : 'Stop task' }}
    </Button>
  </div>
</template>
