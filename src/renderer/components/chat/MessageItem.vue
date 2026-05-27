<script setup lang="ts">
/**
 * Single message display component
 * Note: v-html usage is safe - content is sanitized with DOMPurify in renderMarkdown
 */

import { computed } from 'vue';

import type { ChatMessage } from '@shared/types';

import { formatTime } from '../../utils/date';
import { renderMarkdown } from '../../utils/markdown';
import BackgroundTaskMessage from './BackgroundTaskMessage.vue';
import Spinner from '../shared/Spinner.vue';
import ToolUseMessage from './ToolUseMessage.vue';

interface Props {
  /** The chat message to display */
  message: ChatMessage;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'open-task-detail', taskId: string): void;
}>();

const isUser = computed(() => props.message.role === 'user');
const isSystem = computed(() => props.message.role === 'system');

const formattedTime = computed(() => formatTime(props.message.timestamp));

const renderedContent = computed(() => renderMarkdown(props.message.content));
</script>

<template>
  <!-- System message (e.g. model change notification) -->
  <div
    v-if="isSystem"
    class="flex items-center gap-3 py-2 px-4 animate-fade-in"
  >
    <div class="flex-1 h-px bg-surface-200 dark:bg-surface-700" />
    <span class="text-xs text-surface-400 dark:text-surface-500 whitespace-nowrap">
      {{ message.content }}
    </span>
    <div class="flex-1 h-px bg-surface-200 dark:bg-surface-700" />
  </div>

  <!-- Inline tool use indicator -->
  <ToolUseMessage
    v-else-if="message.toolUse"
    :tool-use="message.toolUse"
  />

  <!-- Inline background task indicator -->
  <BackgroundTaskMessage
    v-else-if="message.backgroundTask"
    :background-task="message.backgroundTask"
    @open-detail="emit('open-task-detail', $event)"
  />

  <!-- User / Assistant message -->
  <div
    v-else
    :class="[
      'rounded-lg animate-fade-in message-bubble',
      isUser ? 'message-user' : 'message-assistant',
    ]"
  >
    <!-- Header -->
    <div class="flex items-center gap-2 message-header">
      <div
        :class="[
          'w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium',
          isUser
            ? 'bg-primary-500 text-white'
            : 'bg-surface-300 dark:bg-surface-600 text-surface-700 dark:text-surface-200',
        ]"
      >
        {{ isUser ? 'U' : 'C' }}
      </div>
      <span class="font-medium text-sm text-surface-700 dark:text-surface-300">
        {{ isUser ? 'You' : 'Claude' }}
      </span>
      <span class="text-xs text-surface-400 dark:text-surface-500">
        {{ formattedTime }}
      </span>
      <Spinner
        v-if="message.isStreaming"
        size="sm"
        class="ml-2 text-primary-500"
      />
    </div>

    <!-- Content -->
    <div
      class="prose prose-sm dark:prose-invert max-w-full text-surface-800 dark:text-surface-200 message-content"
      v-html="renderedContent"
    />
  </div>
</template>

<style scoped>
.message-bubble {
  padding: calc(var(--chat-line-height, 1.6) * 0.6rem);
}

.message-header {
  margin-bottom: calc(var(--chat-line-height, 1.6) * 0.3rem);
}

.message-content {
  font-size: var(--chat-font-size, 14px) !important;
  line-height: var(--chat-line-height, 1.6) !important;
  overflow-wrap: break-word;
  word-break: break-word;
}

/* Force line-height on all prose children (Tailwind Typography sets its own) */
.message-content :deep(*) {
  line-height: inherit !important;
}

/* Code blocks get horizontal scroll instead of overflowing */
.message-content :deep(pre) {
  overflow-x: auto;
  max-width: 100%;
}

/* Scale paragraph spacing with line-height setting */
.message-content :deep(p) {
  margin-top: calc(var(--chat-line-height, 1.6) * 0.3em);
  margin-bottom: calc(var(--chat-line-height, 1.6) * 0.3em);
}

.message-content :deep(p:first-child) {
  margin-top: 0;
}

.message-content :deep(p:last-child) {
  margin-bottom: 0;
}
</style>
