<script setup lang="ts">
/**
 * Message list component - displays chat messages
 *
 * Auto-scroll behavior:
 * - Scrolls to bottom when new messages arrive IF user is already at bottom
 * - Scrolls during streaming IF user is at bottom
 * - Does NOT scroll if user has scrolled up to read previous messages
 *
 * Grouping: consecutive assistant messages (text, tool, task) are rendered
 * inside a single visual bubble ("turn") with one header.
 */

import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';

import type { ChatMessage } from '@shared/types';

import { useChatStore } from '../../stores/chat';
import { formatTime } from '../../utils/date';
import MessageItem from './MessageItem.vue';
import Icon from '../shared/Icon.vue';
import Spinner from '../shared/Spinner.vue';

const emit = defineEmits<{
  (e: 'open-task-detail', taskId: string): void;
  (e: 'open-tool-detail', toolUseBlockId: string): void;
}>();

const chatStore = useChatStore();
const { messages, hasMessages, currentStreamingContent } = storeToRefs(chatStore);

interface MessageGroup {
  id: string;
  type: 'standalone' | 'assistant-turn';
  messages: ChatMessage[];
}

const messageGroups = computed((): MessageGroup[] => {
  const groups: MessageGroup[] = [];
  let currentTurn: ChatMessage[] = [];

  for (const msg of messages.value) {
    if (msg.role === 'assistant') {
      currentTurn.push(msg);
    } else {
      if (currentTurn.length > 0) {
        groups.push({
          id: currentTurn[0].id,
          type: 'assistant-turn',
          messages: [...currentTurn],
        });
        currentTurn = [];
      }
      groups.push({
        id: msg.id,
        type: 'standalone',
        messages: [msg],
      });
    }
  }

  if (currentTurn.length > 0) {
    groups.push({
      id: currentTurn[0].id,
      type: 'assistant-turn',
      messages: [...currentTurn],
    });
  }

  return groups;
});

function isTurnStreaming(group: MessageGroup): boolean {
  return group.messages.some(m => m.isStreaming);
}

const listRef = ref<HTMLDivElement | null>(null);

// Track if user is at/near bottom of scroll (within threshold)
const SCROLL_THRESHOLD = 50; // pixels from bottom to consider "at bottom"
const isUserAtBottom = ref(true);

/**
 * Check if scroll position is at/near bottom
 */
function checkIfAtBottom(): boolean {
  if (!listRef.value) return true;
  const { scrollTop, scrollHeight, clientHeight } = listRef.value;
  return scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD;
}

/**
 * Scroll to bottom of container
 */
function scrollToBottom(): void {
  if (listRef.value) {
    listRef.value.scrollTop = listRef.value.scrollHeight;
  }
}

/**
 * Handle scroll events to track user position
 */
function handleScroll(): void {
  isUserAtBottom.value = checkIfAtBottom();
}

// Auto-scroll to bottom when new messages arrive (if user is at bottom)
watch(
  () => messages.value.length,
  () => {
    nextTick(() => {
      if (isUserAtBottom.value) {
        scrollToBottom();
      }
    });
  }
);

// Auto-scroll during streaming (if user is at bottom)
watch(
  currentStreamingContent,
  () => {
    nextTick(() => {
      if (isUserAtBottom.value) {
        scrollToBottom();
      }
    });
  }
);

defineExpose({ scrollToBottom });

// Set up scroll listener
onMounted(() => {
  if (listRef.value) {
    listRef.value.addEventListener('scroll', handleScroll, { passive: true });
  }
});

onUnmounted(() => {
  if (listRef.value) {
    listRef.value.removeEventListener('scroll', handleScroll);
  }
});
</script>

<template>
  <div
    ref="listRef"
    class="flex-1 overflow-y-auto overflow-x-hidden min-w-0 p-4 message-list-spacing"
  >
    <!-- Empty state -->
    <div
      v-if="!hasMessages"
      class="flex flex-col items-center justify-center h-full text-center"
    >
      <div class="w-16 h-16 mb-4 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center">
        <Icon
          name="chat"
          size="lg"
          class="text-primary-500"
        />
      </div>
      <h3 class="text-lg font-medium text-surface-700 dark:text-surface-300 mb-2">
        Start a conversation
      </h3>
      <p class="text-sm text-surface-500 dark:text-surface-400 max-w-sm">
        Ask Claude to help you with coding, explain concepts, or make changes to your files.
      </p>
    </div>

    <!-- Messages grouped by turn -->
    <div
      v-else
      class="message-list-spacing"
    >
      <template
        v-for="group in messageGroups"
        :key="group.id"
      >
        <!-- Standalone (user/system) message -->
        <MessageItem
          v-if="group.type === 'standalone'"
          :message="group.messages[0]"
          @open-task-detail="emit('open-task-detail', $event)"
          @open-tool-detail="emit('open-tool-detail', $event)"
        />

        <!-- Assistant turn: single bubble with header + interleaved content -->
        <div
          v-else
          class="rounded-lg animate-fade-in message-bubble message-assistant"
        >
          <!-- Turn header -->
          <div class="flex items-center gap-2 assistant-turn-header">
            <div class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium bg-surface-300 dark:bg-surface-600 text-surface-700 dark:text-surface-200">
              C
            </div>
            <span class="font-medium text-sm text-surface-700 dark:text-surface-300">
              Claude
            </span>
            <span class="text-xs text-surface-400 dark:text-surface-500">
              {{ formatTime(group.messages[0].timestamp) }}
            </span>
            <Spinner
              v-if="isTurnStreaming(group)"
              size="sm"
              class="ml-2 text-primary-500"
            />
          </div>

          <!-- Turn content -->
          <div class="assistant-turn-content">
            <MessageItem
              v-for="msg in group.messages"
              :key="msg.id"
              :message="msg"
              grouped
              @open-task-detail="emit('open-task-detail', $event)"
              @open-tool-detail="emit('open-tool-detail', $event)"
            />
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.message-list-spacing > * + * {
  margin-top: calc(var(--chat-line-height, 1.6) * 0.6rem);
}

.assistant-turn-header {
  margin-bottom: calc(var(--chat-line-height, 1.6) * 0.3rem);
}

.assistant-turn-content > * + * {
  margin-top: calc(var(--chat-line-height, 1.6) * 0.25rem);
}

.message-enter-active,
.message-leave-active {
  transition: all 0.2s ease;
}

.message-enter-from {
  opacity: 0;
  transform: translateY(10px);
}

.message-leave-to {
  opacity: 0;
}
</style>
