<script setup lang="ts">
/**
 * Everything scheduled, in every discussion, soonest first: what Claude Code
 * will do later in a discussion's session — cron jobs (CronCreate, /loop)
 * and one-shot wake-ups (ScheduleWakeup), as the CLI lists them at the end of
 * each turn — and a continue this app will send after a usage limit resets.
 *
 * Each line says when it next happens, in which discussion (opened from
 * here), how it repeats, and what it will send.
 */

import { computed } from 'vue';

import { useNowTicker } from '../../composables/useNowTicker';
import { useChatStore } from '../../stores/chat';
import { useConversationsStore } from '../../stores/conversations';
import { formatDuration, formatMoment } from '../../utils/date';
import { scheduleRows, type ScheduleRow } from '../../utils/schedules';

import Modal from './Modal.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const chatStore = useChatStore();
const conversationsStore = useConversationsStore();

const now = useNowTicker(() => props.open);
const rows = computed(() => scheduleRows(chatStore.scheduleSources, now.value));

function titleOf(conversationId: string): string {
  return conversationsStore.conversations.find((c) => c.id === conversationId)?.title || 'Untitled discussion';
}

/** How it repeats, as said where it was made when this app saw it. */
function cadence(row: ScheduleRow): string {
  if (row.kind === 'usage-limit') return 'Continue after the usage limit resets';
  if (row.kind === 'once') return 'Once';
  return row.schedule.humanSchedule ?? 'Repeats';
}

/** When it next happens, or why that cannot be said. */
function when(row: ScheduleRow): string {
  if (row.kind !== 'usage-limit' && row.schedule.paused) {
    return 'Paused — resumes when this discussion runs again';
  }
  if (row.nextRunAt === null) return 'Next run unknown';
  if (row.due) return `Due since ${formatMoment(row.nextRunAt, now.value)}`;
  return `${formatMoment(row.nextRunAt, now.value)} · in ${formatDuration(row.nextRunAt - now.value)}`;
}

/** What it will send when it happens. */
function prompt(row: ScheduleRow): string {
  return row.kind === 'usage-limit' ? 'Continue the task you were working on.' : row.schedule.prompt;
}

async function openDiscussion(conversationId: string): Promise<void> {
  emit('close');
  await conversationsStore.switchConversation(conversationId);
}
</script>

<template>
  <Modal
    :open="open"
    title="Schedules"
    size="2xl"
    resize-key="schedules"
    aria-description="What is scheduled to happen in your discussions, soonest first"
    @close="emit('close')"
  >
    <div
      v-if="rows.length === 0"
      class="schedules-empty py-4 text-sm text-surface-600 dark:text-surface-300 space-y-2"
    >
      <p>Nothing is scheduled.</p>
      <p>
        Claude schedules work in a discussion with cron jobs (CronCreate, /loop) and wake-ups
        (ScheduleWakeup); they show here once a turn of that discussion has ended. A discussion
        stopped by a usage limit shows its automatic continue here too.
      </p>
    </div>

    <ul
      v-else
      class="schedules-list divide-y divide-surface-200 dark:divide-surface-700"
    >
      <li
        v-for="row in rows"
        :key="row.key"
        class="schedule-row py-3 space-y-1"
        :data-kind="row.kind"
      >
        <div class="flex items-baseline justify-between gap-3">
          <span
            class="schedule-when text-sm font-medium"
            :class="row.due ? 'text-warning-600 dark:text-warning-400' : 'text-surface-800 dark:text-surface-100'"
          >{{ when(row) }}</span>
          <span class="schedule-cadence text-xs text-surface-500 dark:text-surface-400 shrink-0">{{ cadence(row) }}</span>
        </div>
        <button
          class="schedule-discussion text-sm text-primary-600 dark:text-primary-400 hover:underline text-left"
          :title="`Open ${titleOf(row.conversationId)}`"
          @click="openDiscussion(row.conversationId)"
        >
          {{ titleOf(row.conversationId) }}
        </button>
        <details class="text-xs text-surface-600 dark:text-surface-300">
          <summary class="schedule-prompt cursor-pointer truncate">
            {{ prompt(row) }}
          </summary>
          <p class="mt-1 whitespace-pre-wrap break-words">
            {{ prompt(row) }}
          </p>
          <p
            v-if="row.kind !== 'usage-limit'"
            class="schedule-details mt-1 font-mono text-surface-500 dark:text-surface-400"
          >
            {{ row.schedule.schedule }} · id {{ row.schedule.id }}{{ row.schedule.durable ? ' · kept across restarts' : '' }}
          </p>
        </details>
      </li>
    </ul>
  </Modal>
</template>
