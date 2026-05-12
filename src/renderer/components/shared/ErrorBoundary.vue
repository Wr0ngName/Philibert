<script setup lang="ts">
/**
 * Error boundary component for catching and displaying Vue component errors.
 * Prevents the entire app from crashing when a component throws an error.
 */

import { ref, onErrorCaptured } from 'vue';
import { logger } from '../../utils/logger';
import Button from './Button.vue';
import Icon from './Icon.vue';

const error = ref<Error | null>(null);
const errorInfo = ref<string>('');

onErrorCaptured((err: Error, instance, info: string) => {
  error.value = err;
  errorInfo.value = info;

  logger.error('Vue component error caught by ErrorBoundary', {
    error: err.message,
    stack: err.stack,
    info,
    component: instance?.$options?.name || 'Unknown',
  });

  // Return false to prevent error from propagating further
  return false;
});

function reset() {
  error.value = null;
  errorInfo.value = '';
}

function reload() {
  window.location.reload();
}
</script>

<template>
  <div
    v-if="error"
    class="error-boundary"
  >
    <div class="error-container">
      <div class="error-icon">
        <Icon
          name="warning"
          size="xl"
          class="text-red-500"
          style="width: 4rem; height: 4rem;"
        />
      </div>

      <h2 class="error-title">
        Something went wrong
      </h2>

      <p class="error-message">
        {{ error.message }}
      </p>

      <details class="error-details">
        <summary class="error-details-summary">
          Technical details
        </summary>
        <div class="error-stack">
          <p><strong>Component:</strong> {{ errorInfo }}</p>
          <pre>{{ error.stack }}</pre>
        </div>
      </details>

      <div class="error-actions">
        <Button
          variant="ghost"
          @click="reset"
        >
          Try Again
        </Button>
        <Button
          variant="primary"
          @click="reload"
        >
          Reload App
        </Button>
      </div>
    </div>
  </div>
  <slot v-else />
</template>

<style scoped>
.error-boundary {
  @apply fixed inset-0 flex items-center justify-center bg-surface-100 dark:bg-surface-900 p-4 z-50;
}

.error-container {
  @apply max-w-lg w-full bg-white dark:bg-surface-800 rounded-xl shadow-xl p-8 text-center;
}

.error-icon {
  @apply flex justify-center mb-4;
}

.error-title {
  @apply text-2xl font-bold text-surface-900 dark:text-white mb-2;
}

.error-message {
  @apply text-surface-600 dark:text-surface-400 mb-4;
}

.error-details {
  @apply text-left mb-6;
}

.error-details-summary {
  @apply text-sm text-surface-500 dark:text-surface-400 cursor-pointer hover:text-surface-700 dark:hover:text-surface-200;
}

.error-stack {
  @apply mt-2 p-3 bg-surface-100 dark:bg-surface-700 rounded text-xs font-mono overflow-auto max-h-48;
}

.error-stack pre {
  @apply whitespace-pre-wrap break-words text-surface-600 dark:text-surface-300;
}

.error-actions {
  @apply flex justify-center gap-3;
}
</style>
