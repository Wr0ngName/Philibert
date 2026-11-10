<script setup lang="ts">
/**
 * The header's schedules button: how many things are scheduled ahead, in
 * every discussion, and the view listing them (SchedulesModal).
 */

import { computed, onUnmounted, ref } from 'vue';

import { useChatStore } from '../../stores/chat';
import { scheduleRows } from '../../utils/schedules';

import Icon from './Icon.vue';
import SchedulesModal from './SchedulesModal.vue';

const chatStore = useChatStore();
const open = ref(false);

/**
 * The badge's count: scheduled things with a time ahead. Its clock moves once
 * a minute, as fine as a cron time is; the modal keeps its own.
 */
const clock = ref(Date.now());
const timer = setInterval(() => { clock.value = Date.now(); }, 60_000);
onUnmounted(() => clearInterval(timer));
const upcoming = computed(() =>
  scheduleRows(chatStore.scheduleSources, clock.value).filter((row) => row.nextRunAt !== null).length);
</script>

<template>
  <button
    class="schedules-button btn-icon relative"
    :title="upcoming > 0 ? `Schedules (${upcoming} upcoming)` : 'Schedules'"
    @click="open = true"
  >
    <Icon name="calendar" />
    <span
      v-if="upcoming > 0"
      class="schedules-count absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-primary-500 text-white text-[10px] leading-4 text-center"
    >{{ upcoming }}</span>
  </button>
  <SchedulesModal
    :open="open"
    @close="open = false"
  />
</template>
