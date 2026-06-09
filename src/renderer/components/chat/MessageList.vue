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

interface VisibleItem {
  msg: ChatMessage;
  depth: number;
  childCount: number;
  isExpanded: boolean;
}

// Tracks which sub-agent groups are expanded, keyed by parent tool_use block ID.
// Collapsed by default — sub-agent activity hides behind a "N actions ▸" pill.
const expandedAgents = ref<Set<string>>(new Set());

function toggleAgentExpand(toolUseId: string): void {
  const next = new Set(expandedAgents.value);
  if (next.has(toolUseId)) {
    next.delete(toolUseId);
  } else {
    next.add(toolUseId);
  }
  expandedAgents.value = next;
}

// Index: parent tool_use ID → direct child messages
const childrenByParent = computed((): Map<string, ChatMessage[]> => {
  const map = new Map<string, ChatMessage[]>();
  for (const m of messages.value) {
    const parent = m.toolUse?.parentToolUseId;
    if (!parent) continue;
    const list = map.get(parent);
    if (list) {
      list.push(m);
    } else {
      map.set(parent, [m]);
    }
  }
  return map;
});

// Set of tool_use block IDs that exist in the conversation.
// Used to detect orphan children (parent missing) so they surface at top level
// instead of disappearing.
const knownToolUseIds = computed((): Set<string> => {
  const s = new Set<string>();
  for (const m of messages.value) {
    const id = m.toolUse?.toolUseBlockId;
    if (id) s.add(id);
  }
  return s;
});

// Transitive count of tool_use descendants per parent tool_use ID.
const descendantCount = computed((): Map<string, number> => {
  const counts = new Map<string, number>();
  const visiting = new Set<string>();
  function count(id: string): number {
    const cached = counts.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // cycle guard
    visiting.add(id);
    const kids = childrenByParent.value.get(id) ?? [];
    let n = 0;
    for (const k of kids) {
      if (!k.toolUse) continue;
      n++;
      const kid = k.toolUse.toolUseBlockId;
      if (kid) n += count(kid);
    }
    visiting.delete(id);
    counts.set(id, n);
    return n;
  }
  for (const m of messages.value) {
    const id = m.toolUse?.toolUseBlockId;
    if (id) count(id);
  }
  return counts;
});

// Messages whose parent is unknown (or absent) — these get rendered at top level.
const topLevelMessages = computed((): ChatMessage[] => {
  return messages.value.filter((m) => {
    const parent = m.toolUse?.parentToolUseId;
    if (!parent) return true;
    return !knownToolUseIds.value.has(parent);
  });
});

const messageGroups = computed((): MessageGroup[] => {
  const groups: MessageGroup[] = [];
  let currentTurn: ChatMessage[] = [];

  for (const msg of topLevelMessages.value) {
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

/**
 * Flatten a turn's top-level messages into a visible list, recursively
 * including the children of any expanded sub-agent.
 */
function getVisibleTurnItems(group: MessageGroup): VisibleItem[] {
  const out: VisibleItem[] = [];
  function walk(msg: ChatMessage, depth: number): void {
    const id = msg.toolUse?.toolUseBlockId;
    const childCount = id ? (descendantCount.value.get(id) ?? 0) : 0;
    const isExpanded = id ? expandedAgents.value.has(id) : false;
    out.push({ msg, depth, childCount, isExpanded });
    if (id && isExpanded) {
      const kids = childrenByParent.value.get(id) ?? [];
      for (const k of kids) walk(k, depth + 1);
    }
  }
  for (const m of group.messages) walk(m, 0);
  return out;
}

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
const SCROLL_THRESHOLD = 80; // pixels from bottom to consider "at bottom"
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

const HIGHLIGHT_DURATION_MS = 1800;

/**
 * Scroll the named message into view and briefly highlight it. Used by the
 * search modal after switching conversations so the user lands directly on
 * the match instead of having to hunt for it manually.
 *
 * Retries for up to ~1s after mount because the conversation switch and
 * the message-list re-render race the call from the search modal.
 */
async function scrollToMessage(messageId: string): Promise<void> {
  if (!listRef.value || !messageId) return;
  const root = listRef.value;
  const escapedId = (window.CSS && CSS.escape) ? CSS.escape(messageId) : messageId.replace(/"/g, '\\"');
  const selector = `[data-message-id="${escapedId}"]`;

  let target: HTMLElement | null = null;
  for (let attempt = 0; attempt < 10 && !target; attempt++) {
    await nextTick();
    target = root.querySelector<HTMLElement>(selector);
    if (!target) await new Promise((r) => setTimeout(r, 80));
  }
  if (!target) return;

  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('search-hit-flash');
  setTimeout(() => target?.classList.remove('search-hit-flash'), HIGHLIGHT_DURATION_MS);

  // Once the user has explicitly jumped to an older message, stop the
  // auto-scroll-to-bottom watchers from yanking them back on the next event.
  isUserAtBottom.value = false;
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

defineExpose({ scrollToBottom, scrollToMessage });

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
          <div
            v-if="group.type === 'standalone'"
            :data-message-id="group.messages[0].id"
          >
            <MessageItem
              :message="group.messages[0]"
              @open-task-detail="emit('open-task-detail', $event)"
              @open-tool-detail="emit('open-tool-detail', $event)"
            />
          </div>

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
              <div
                v-for="item in getVisibleTurnItems(group)"
                :key="item.msg.id"
                :data-message-id="item.msg.id"
                :class="item.depth > 0 ? 'nested-agent-item' : ''"
                :style="item.depth > 0 ? { paddingLeft: (item.depth * 0.75) + 'rem' } : undefined"
              >
                <MessageItem
                  :message="item.msg"
                  :child-count="item.childCount"
                  :is-expanded="item.isExpanded"
                  grouped
                  @open-task-detail="emit('open-task-detail', $event)"
                  @open-tool-detail="emit('open-tool-detail', $event)"
                  @toggle-agent-expand="toggleAgentExpand"
                />
              </div>
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

/* Subtle left rail for sub-agent activity to anchor depth visually */
.nested-agent-item {
  border-left: 1px dashed rgb(163 163 163 / 0.35);
  margin-left: 0.5rem;
}

:root.dark .nested-agent-item,
.dark .nested-agent-item {
  border-color: rgb(120 120 120 / 0.4);
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

/* Brief amber flash applied when a search result is scrolled into view, so
   the user lands directly on the matched message instead of having to scan. */
.search-hit-flash {
  animation: search-hit-flash 1.6s ease-out;
  border-radius: 0.5rem;
}

@keyframes search-hit-flash {
  0% { background-color: rgba(245, 158, 11, 0.35); box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.5); }
  100% { background-color: transparent; box-shadow: 0 0 0 2px transparent; }
}
</style>
