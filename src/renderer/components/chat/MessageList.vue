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
const { messages, hasMessages, currentStreamingContent, isLoading } = storeToRefs(chatStore);

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

/**
 * Whether an assistant turn should show its spinner.
 * True when streaming text, OR when this is the last group and the
 * conversation is still loading (tools running before any text arrives).
 */
function showTurnSpinner(group: MessageGroup): boolean {
  if (isTurnStreaming(group)) return true;
  if (!isLoading.value) return false;
  const groups = messageGroups.value;
  return groups.length > 0 && groups[groups.length - 1].id === group.id;
}

/**
 * Whether to show a placeholder "Claude is thinking" bubble.
 * True when loading and the last message is NOT an assistant message
 * (i.e., Claude hasn't produced any output yet — no text, no tools).
 */
const showThinkingPlaceholder = computed(() => {
  if (!isLoading.value || messages.value.length === 0) return false;
  const last = messages.value[messages.value.length - 1];
  return last.role !== 'assistant';
});

const listRef = ref<HTMLDivElement | null>(null);

// Track if user is at/near bottom of scroll (within threshold)
const SCROLL_THRESHOLD = 50; // pixels from bottom to consider "at bottom"
const isUserAtBottom = ref(true);
const unreadCount = ref(0);

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
  if (isUserAtBottom.value) {
    unreadCount.value = 0;
  }
}

function handleScrollToBottom(): void {
  scrollToBottom();
  unreadCount.value = 0;
}

// Auto-scroll to bottom when new messages arrive (if user is at bottom)
watch(
  () => messages.value.length,
  (newLen, oldLen) => {
    const added = newLen - (oldLen ?? 0);
    if (added > 0 && !isUserAtBottom.value) {
      unreadCount.value += added;
    }
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

// Auto-scroll when loading starts (thinking placeholder appears).
// isUserAtBottom retains its value from the last scroll event, so it reflects the state
// BEFORE the spinner was rendered — which is correct for the scroll decision.
watch(
  isLoading,
  (loading) => {
    if (loading) {
      nextTick(() => {
        if (isUserAtBottom.value) {
          scrollToBottom();
        }
      });
    }
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
  <div class="relative flex-1 min-w-0">
    <div
      ref="listRef"
      class="absolute inset-0 overflow-y-auto overflow-x-hidden p-4 message-list-spacing"
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
                v-if="showTurnSpinner(group)"
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

        <!-- Thinking placeholder: shown when loading but no assistant output yet -->
        <div
          v-if="showThinkingPlaceholder"
          class="rounded-lg animate-fade-in message-bubble message-assistant"
        >
          <div class="flex items-center gap-2">
            <div class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium bg-surface-300 dark:bg-surface-600 text-surface-700 dark:text-surface-200">
              C
            </div>
            <span class="font-medium text-sm text-surface-700 dark:text-surface-300">
              Claude
            </span>
            <Spinner
              size="sm"
              class="ml-2 text-primary-500"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- Scroll to new messages button -->
    <Transition name="scroll-badge">
      <button
        v-if="!isUserAtBottom && (unreadCount > 0 || isLoading)"
        class="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary-500 hover:bg-primary-600 text-white text-xs font-medium shadow-lg transition-colors z-10"
        @click="handleScrollToBottom"
      >
        <Icon
          name="chevron-down"
          size="xs"
        />
        <span v-if="unreadCount > 0">{{ unreadCount }} new message{{ unreadCount > 1 ? 's' : '' }}</span>
        <span v-else>New activity</span>
      </button>
    </Transition>
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

.scroll-badge-enter-active,
.scroll-badge-leave-active {
  transition: all 0.2s ease;
}

.scroll-badge-enter-from,
.scroll-badge-leave-to {
  opacity: 0;
  transform: translate(-50%, 10px);
}
</style>
