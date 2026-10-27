<script setup lang="ts">
/**
 * Usage warning banner — what interactive Claude Code shows as "You've used
 * 80% of your session limit · resets 7pm", so the limit does not come as a
 * surprise mid-task.
 *
 * The account's, not a conversation's, so it spans the window like the model
 * banner. It goes when the server says usage is back under its thresholds,
 * when the reset time passes, or when dismissed — until the server warns
 * about something new (see usageWarningKey).
 */

import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';

import { useNowTicker } from '../../composables/useNowTicker';
import { useChatStore } from '../../stores/chat';
import { usageWarningKey, usageWarningMessage } from '../../utils/usage-limit';
import NoticeBanner from './NoticeBanner.vue';

const { usageWarning } = storeToRefs(useChatStore());

const dismissedKey = ref('');

/** A live clock, so the banner goes when the limit resets. */
const now = useNowTicker(() => usageWarning.value !== null);

const isVisible = computed(() => {
  const warning = usageWarning.value;
  if (!warning || dismissedKey.value === usageWarningKey(warning)) return false;
  return warning.resetsAt === undefined || warning.resetsAt > now.value;
});

const message = computed(() => (usageWarning.value ? usageWarningMessage(usageWarning.value, now.value) : ''));

function dismiss(): void {
  if (usageWarning.value) dismissedKey.value = usageWarningKey(usageWarning.value);
}
</script>

<template>
  <Transition
    enter-active-class="transition-all duration-300 ease-out"
    enter-from-class="-translate-y-full opacity-0"
    enter-to-class="translate-y-0 opacity-100"
    leave-active-class="transition-all duration-200 ease-in"
    leave-from-class="translate-y-0 opacity-100"
    leave-to-class="-translate-y-full opacity-0"
  >
    <NoticeBanner
      v-if="isVisible"
      variant="bar"
      data-testid="usage-warning"
    >
      {{ message }}
      <template #actions>
        <button
          class="btn-sm btn-ghost"
          @click="dismiss"
        >
          Dismiss
        </button>
      </template>
    </NoticeBanner>
  </Transition>
</template>
