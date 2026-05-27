<script setup lang="ts">
/**
 * Message list component - displays chat messages
 *
 * Auto-scroll behavior:
 * - Scrolls to bottom when new messages arrive IF user is already at bottom
 * - Scrolls during streaming IF user is at bottom
 * - Does NOT scroll if user has scrolled up to read previous messages
 */

import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';

import { useChatStore } from '../../stores/chat';
import MessageItem from './MessageItem.vue';
import Icon from '../shared/Icon.vue';

const emit = defineEmits<{
  (e: 'open-task-detail', taskId: string): void;
}>();

const chatStore = useChatStore();
const { messages, hasMessages, currentStreamingContent } = storeToRefs(chatStore);

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

    <!-- Messages -->
    <TransitionGroup
      v-else
      name="message"
      tag="div"
      class="message-list-spacing"
    >
      <MessageItem
        v-for="message in messages"
        :key="message.id"
        :message="message"
        @open-task-detail="emit('open-task-detail', $event)"
      />
    </TransitionGroup>
  </div>
</template>

<style scoped>
.message-list-spacing > * + * {
  margin-top: calc(var(--chat-line-height, 1.6) * 0.6rem);
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
