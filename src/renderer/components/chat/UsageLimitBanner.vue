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

import type { UsageLimitWait } from '@shared/types';

import { useNowTicker } from '../../composables/useNowTicker';
import { useSettingsStore } from '../../stores/settings';
import { usageLimitBanner } from '../../utils/usage-limit';
import NoticeBanner from '../shared/NoticeBanner.vue';

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

const settingsStore = useSettingsStore();

const banner = computed(() => usageLimitBanner(props.wait, settingsStore.usageLimitWaitDays, now.value));
const scheduled = computed(() => banner.value.kind === 'waiting' || banner.value.kind === 'resuming');
</script>

<template>
  <NoticeBanner>
    {{ banner.message }}
    <template #actions>
      <button
        v-if="banner.kind === 'offer'"
        type="button"
        class="btn-sm btn-amber"
        @click="emit('schedule')"
      >
        Continue automatically
      </button>
      <button
        v-if="scheduled || banner.kind === 'ready' || banner.kind === 'missed'"
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
    </template>
  </NoticeBanner>
</template>
