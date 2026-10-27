<script setup lang="ts">
/**
 * An amber notice with a warning icon, a one-line message and its actions —
 * the look every warning banner shares (model switched, usage limit close,
 * usage limit reached). Each banner says what and offers which actions; this
 * is only how they look.
 *
 * `bar` spans the window under its header, as a strip; `card` sits inside the
 * chat, above the input, as a rounded block.
 */

import Icon from './Icon.vue';

withDefaults(defineProps<{ variant?: 'bar' | 'card' }>(), { variant: 'card' });
</script>

<template>
  <div
    class="notice-banner"
    :class="variant === 'bar' ? 'notice-banner--bar' : 'notice-banner--card'"
    role="status"
  >
    <div class="flex items-center gap-2 min-w-0">
      <Icon
        name="warning"
        size="sm"
        class="shrink-0 text-amber-600 dark:text-amber-400"
      />
      <span class="truncate"><slot /></span>
    </div>
    <div
      v-if="$slots.actions"
      class="flex items-center gap-2 shrink-0"
    >
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
@reference "../../assets/styles/main.css";
.notice-banner {
  @apply flex items-center justify-between gap-4;
  @apply bg-amber-50 dark:bg-amber-900/30;
  @apply text-sm text-surface-700 dark:text-surface-200;
}

.notice-banner--bar {
  @apply px-4 py-2 border-b border-amber-200 dark:border-amber-800;
}

.notice-banner--card {
  @apply px-3 py-2 rounded-lg border border-amber-200 dark:border-amber-800;
}

/* The actions are the banner user's buttons, given the banner's look. */
:slotted(.btn-sm) {
  @apply px-3 py-1 text-sm font-medium rounded-md transition-colors;
}

:slotted(.btn-amber) {
  @apply bg-amber-600 text-white hover:bg-amber-700;
}

:slotted(.btn-ghost) {
  @apply text-surface-600 dark:text-surface-400 hover:bg-surface-200 dark:hover:bg-surface-700;
}
</style>
