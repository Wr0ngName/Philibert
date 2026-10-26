<script setup lang="ts">
/**
 * Usage limit banner — what the CLI shows as "Usage limit reached · continuing
 * automatically at 7:50pm · esc to cancel", with the choices that go with it.
 *
 * Stays until a turn starts or the user dismisses it: the stop is the reason
 * the task is sitting there unfinished, and saying so once in a toast would
 * leave the transcript ending on a refusal with nothing to explain the wait.
 */

import { computed } from 'vue';

import { useNowTicker } from '../../composables/useNowTicker';
import { usageLimitBanner, type UsageLimitWait } from '../../utils/usage-limit';
import Icon from '../shared/Icon.vue';

interface Props {
  wait: UsageLimitWait;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'continue-now'): void;
  (e: 'schedule'): void;
  (e: 'cancel'): void;
  (e: 'dismiss'): void;
}>();

/** A live clock, so the wording follows the reset as it passes. */
const now = useNowTicker(() => true);

const banner = computed(() => usageLimitBanner(props.wait, now.value));
const scheduled = computed(() => banner.value.kind === 'waiting' || banner.value.kind === 'resuming');
</script>

<template>
  <div
    class="usage-limit-banner"
    role="status"
  >
    <div class="flex items-center gap-2 min-w-0">
      <Icon
        name="warning"
        size="sm"
        class="shrink-0 text-amber-600 dark:text-amber-400"
      />
      <span class="truncate">{{ banner.message }}</span>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      <button
        v-if="banner.kind === 'offer'"
        type="button"
        class="btn-sm btn-amber"
        @click="emit('schedule')"
      >
        Continue automatically
      </button>
      <button
        v-if="scheduled || banner.kind === 'ready'"
        type="button"
        class="btn-sm btn-amber"
        @click="emit('continue-now')"
      >
        Continue now
      </button>
      <button
        v-if="scheduled"
        type="button"
        class="btn-sm btn-ghost"
        @click="emit('cancel')"
      >
        Cancel
      </button>
      <button
        v-else
        type="button"
        class="btn-sm btn-ghost"
        @click="emit('dismiss')"
      >
        Dismiss
      </button>
    </div>
  </div>
</template>

<style scoped>
@reference "../../assets/styles/main.css";
.usage-limit-banner {
  @apply flex items-center justify-between gap-4 px-3 py-2 rounded-lg;
  @apply bg-amber-50 dark:bg-amber-900/30;
  @apply border border-amber-200 dark:border-amber-800;
  @apply text-sm text-surface-700 dark:text-surface-200;
}

.btn-sm {
  @apply px-3 py-1 text-sm font-medium rounded-md transition-colors;
}

.btn-amber {
  @apply bg-amber-600 text-white hover:bg-amber-700;
}

.btn-ghost {
  @apply text-surface-600 dark:text-surface-400 hover:bg-surface-200 dark:hover:bg-surface-700;
}
</style>
