<script setup lang="ts">
/**
 * Messages sent into work under way that the reader has not read yet: they
 * are read at its next step, and join what it was sent only then — so until
 * they do, this is the only sign that they were sent.
 *
 * The same for the user's prompts sent into a busy discussion, read by
 * Claude, and for the main conversation's messages to a running agent, read
 * by that agent. What can be done with one (taking it back, for a prompt)
 * is the caller's, in the `action` slot.
 */

import Icon from '../shared/Icon.vue';

defineProps<{
  messages: { key: string; content: string }[];
  /** Who reads them: "Claude", or the agent. */
  reader: string;
}>();

defineSlots<{
  action?(props: { index: number }): unknown;
}>();
</script>

<template>
  <div
    v-if="messages.length > 0"
    class="rounded-lg border border-primary-200 dark:border-primary-800 bg-primary-50/50 dark:bg-primary-900/10"
  >
    <div class="flex items-center gap-1.5 px-3 py-2 border-b border-primary-200 dark:border-primary-800 text-xs font-medium text-surface-600 dark:text-surface-300">
      <Icon
        name="send"
        size="xs"
      />
      {{ messages.length }} sent
      <span class="font-normal text-surface-400 dark:text-surface-500">
        · {{ reader }} reads {{ messages.length === 1 ? 'it' : 'them' }} at its next step
      </span>
    </div>
    <ul class="divide-y divide-primary-200 dark:divide-primary-800">
      <li
        v-for="(message, index) in messages"
        :key="message.key"
        class="flex items-start gap-2 px-3 py-2"
      >
        <span class="flex-1 min-w-0 text-xs text-surface-700 dark:text-surface-200 whitespace-pre-wrap break-words line-clamp-3">{{ message.content }}</span>
        <slot
          name="action"
          :index="index"
        />
      </li>
    </ul>
  </div>
</template>
