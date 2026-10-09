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

import { useVirtualList } from '../../composables/useVirtualList';
import { useChatStore } from '../../stores/chat';
import { formatTime } from '../../utils/date';
import {
  childrenByParent as buildChildrenByParent,
  descendantCounts,
  topLevelSequence,
} from '../../utils/message-tree';
import MessageItem from './MessageItem.vue';
import Icon from '../shared/Icon.vue';
import Spinner from '../shared/Spinner.vue';

const emit = defineEmits<{
  (e: 'open-task-detail', taskId: string): void;
  (e: 'open-tool-detail', toolUseBlockId: string): void;
}>();

const chatStore = useChatStore();
const { messages, hasMessages, currentStreamingContent, isLoading } = storeToRefs(chatStore);

// Declared up here because useVirtualList reads it while the component sets
// up, which is before the scrolling section further down would have run.
const listRef = ref<HTMLDivElement | null>(null);

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
const childrenByParent = computed((): Map<string, ChatMessage[]> =>
  buildChildrenByParent(messages.value),
);

// Transitive count of tool_use descendants per parent tool_use ID.
const descendantCount = computed((): Map<string, number> => descendantCounts(messages.value));

/**
 * The main conversation.
 *
 * A tool call whose parent agent is missing from the list used to be promoted
 * to top level here, so an agent's edits and commands appeared as though
 * Claude had made them directly in the main thread. They are now given a
 * stand-in parent and collapse behind it like any other agent — see
 * topLevelSequence.
 */
const topLevelMessages = computed((): ChatMessage[] => topLevelSequence(messages.value));

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

/**
 * One rendered row.
 *
 * The list is flattened to rows so only the rows on screen need to be
 * mounted. A turn is therefore no longer one element: its header, its content
 * and its trailing spinner are separate rows, and the bubble is drawn as
 * contiguous slices (see `sliceClass`) so it survives being cut by the window.
 */
interface Row {
  key: string;
  kind: 'standalone' | 'turn-header' | 'turn-item' | 'turn-spinner' | 'thinking';
  msg?: ChatMessage;
  depth: number;
  childCount: number;
  isExpanded: boolean;
  /** First row of a turn bubble: rounds and closes its top. */
  bubbleFirst: boolean;
  /** Last row of a turn bubble: rounds and closes its bottom. */
  bubbleLast: boolean;
  /** Header timestamp. */
  timestamp?: number;
  /** Starts a new visual block, so it carries the gap above it. */
  startsBlock: boolean;
}

function blankRow(key: string, kind: Row['kind']): Row {
  return {
    key,
    kind,
    depth: 0,
    childCount: 0,
    isExpanded: false,
    bubbleFirst: false,
    bubbleLast: false,
    startsBlock: false,
  };
}

const rows = computed((): Row[] => {
  const out: Row[] = [];

  for (const group of messageGroups.value) {
    if (group.type === 'standalone') {
      // MessageItem draws its own bubble for these, so no slicing.
      const row = blankRow(group.messages[0].id, 'standalone');
      row.msg = group.messages[0];
      row.startsBlock = true;
      out.push(row);
      continue;
    }

    const turnRows: Row[] = [];

    const header = blankRow(`${group.id}:header`, 'turn-header');
    header.bubbleFirst = true;
    header.startsBlock = true;
    header.timestamp = group.messages[0].timestamp;
    turnRows.push(header);

    for (const item of getVisibleTurnItems(group)) {
      const row = blankRow(item.msg.id, 'turn-item');
      row.msg = item.msg;
      row.depth = item.depth;
      row.childCount = item.childCount;
      row.isExpanded = item.isExpanded;
      turnRows.push(row);
    }

    if (showTurnSpinner(group)) {
      turnRows.push(blankRow(`${group.id}:spinner`, 'turn-spinner'));
    }

    turnRows[turnRows.length - 1].bubbleLast = true;
    out.push(...turnRows);
  }

  if (showThinkingPlaceholder.value) {
    const row = blankRow('thinking', 'thinking');
    row.startsBlock = true;
    out.push(row);
  }

  return out;
});

const rowKeys = computed((): string[] => rows.value.map((r) => r.key));

const virtual = useVirtualList({
  container: listRef,
  keys: () => rowKeys.value,
});

const virtualWindow = computed(() => virtual.window.value);

const visibleRows = computed((): Row[] =>
  rows.value.slice(virtualWindow.value.start, virtualWindow.value.end),
);

/** Row elements currently mounted, so each can be unobserved when replaced. */
const rowElements = new Map<string, HTMLElement>();

/**
 * Template ref callback for a row. Vue passes null as a row unmounts, which is
 * when its element must stop being observed — a ResizeObserver holds its
 * targets strongly, so leaving them attached would leak every row the user
 * ever scrolled past.
 */
function bindRow(key: string, el: unknown): void {
  const previous = rowElements.get(key);
  if (el instanceof HTMLElement) {
    if (previous && previous !== el) virtual.releaseRow(previous);
    rowElements.set(key, el);
    virtual.measureRow(key, el);
    return;
  }
  if (previous) {
    virtual.releaseRow(previous);
    rowElements.delete(key);
  }
}

/** Classes drawing a turn bubble as a slice of itself. */
function sliceClass(row: Row): string[] {
  if (row.kind === 'standalone') return [];
  if (row.kind === 'thinking') {
    return ['rounded-lg', 'animate-fade-in', 'message-bubble', 'message-assistant'];
  }
  // Colours taken from the `message-assistant` utility so a sliced bubble is
  // indistinguishable from the single-element one it replaces.
  const classes = [
    'turn-slice',
    'bg-white',
    'dark:bg-surface-800',
    'border-x',
    'border-surface-200',
    'dark:border-surface-700',
  ];
  if (row.bubbleFirst) classes.push('turn-slice-first', 'border-t', 'rounded-t-lg');
  if (row.bubbleLast) classes.push('turn-slice-last', 'border-b', 'rounded-b-lg');
  if (row.kind !== 'turn-header') classes.push('turn-slice-inner-gap');
  return classes;
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
  // The spinner is bounded by the turn, never by message flags alone.
  //
  // isStreaming used to be checked first and unconditionally, so a single
  // message left with the flag kept the spinner up forever regardless of
  // whether anything was running. Messages get stranded easily: appendChunk
  // auto-starts a streaming assistant message whenever chunks arrive without
  // one, which includes text produced after the turn already ended (a
  // background agent reporting back), and nothing then finishes it.
  //
  // Gating on isLoading removes that entire class of bug: no turn in flight
  // means no spinner, whatever the message flags say. Streaming only ever
  // happens inside a turn, so nothing legitimate is lost.
  if (!isLoading.value) return false;
  if (isTurnStreaming(group)) return true;
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

  // A virtualised target is probably not mounted, so no selector could find
  // it. Jump the scroll position to where its row sits first; the retry loop
  // below then finds the real element once that slice has rendered, and
  // centres it properly.
  if (virtual.enabled.value) {
    const index = rows.value.findIndex((r) => r.msg?.id === messageId);
    if (index >= 0) {
      root.scrollTop = virtual.offsetOf(index);
      virtual.syncViewport();
      await nextTick();
    }
  }
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
  // The window to render is derived from the scroll position, so this has to
  // run before anything reads it.
  virtual.syncViewport();
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

// MutationObserver catches DOM additions inside the scroll container that the
// reactive length watcher misses — specifically new sub-agent child tool_use
// items rendered inside an expanded parent, and late text streaming reflows.
// The length watcher's nextTick can run before the child layout is committed,
// leaving scrollHeight stale.
let contentObserver: MutationObserver | null = null;

// ResizeObserver catches the scroll VIEWPORT changing size, which neither of
// the other mechanisms can see.
//
// The scroll container is `absolute inset-0` inside a `flex-1` root, and the
// background-task panel, task list and pending-actions blocks are flex
// siblings below it. When one of those appears — an agent starting is the
// common case — the container's clientHeight shrinks. Nothing else notices:
// scrollTop is unchanged so no scroll event fires, and nothing mutated inside
// the container so the MutationObserver stays quiet. The tail of the
// conversation slides out of view behind the newly-appeared panel and stays
// there.
//
// It also breaks auto-scroll permanently rather than just once: shrinking the
// viewport grows `scrollHeight - scrollTop - clientHeight` past
// SCROLL_THRESHOLD, so the next scroll event latches isUserAtBottom to false
// and the watchers stop following the conversation at all.
let viewportObserver: ResizeObserver | null = null;

// Set up scroll listener + content-mutation observer + viewport-resize observer
// Measurements belong to one conversation's rows. Switching conversation
// replaces every row, and keeping stale heights would place the new ones with
// the old one's geometry.
watch(
  () => chatStore.currentConversationId,
  () => {
    virtual.reset();
    nextTick(() => virtual.syncViewport());
  },
);

onMounted(() => {
  if (listRef.value) {
    virtual.syncViewport();
    listRef.value.addEventListener('scroll', handleScroll, { passive: true });

    contentObserver = new MutationObserver(() => {
      if (isUserAtBottom.value) scrollToBottom();
    });
    contentObserver.observe(listRef.value, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Guarded: happy-dom and older runtimes may not provide ResizeObserver.
    if (typeof ResizeObserver !== 'undefined') {
      viewportObserver = new ResizeObserver(() => {
        // A shorter viewport shows fewer rows, so the window has to be
        // recomputed even when the scroll position has not moved.
        virtual.syncViewport();
        // isUserAtBottom still holds the pre-resize state here: a resize emits
        // no scroll event, and ResizeObserver runs before paint. So it is
        // exactly the right question — was the user following the tail before
        // the panel took this space?
        if (isUserAtBottom.value) scrollToBottom();
      });
      viewportObserver.observe(listRef.value);
    }
  }
});

onUnmounted(() => {
  if (listRef.value) {
    listRef.value.removeEventListener('scroll', handleScroll);
  }
  contentObserver?.disconnect();
  contentObserver = null;
  viewportObserver?.disconnect();
  viewportObserver = null;
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

      <!--
        Flat, windowed row list.

        When virtualising, the outer div is a spacer holding the full scroll
        height and the inner one is translated to where the rendered slice
        belongs; otherwise both are inert and the rows simply flow. One markup
        path either way, so a short conversation and a long one render
        identically.
      -->
      <div
        v-else
        :style="virtual.enabled.value
          ? { height: virtualWindow.totalHeight + 'px', position: 'relative' }
          : undefined"
      >
        <div
          :style="virtual.enabled.value
            ? { position: 'absolute', top: '0px', left: '0px', right: '0px',
                transform: `translateY(${virtualWindow.offsetTop}px)` }
            : undefined"
        >
          <div
            v-for="row in visibleRows"
            :key="row.key"
            :ref="(el) => bindRow(row.key, el)"
            :class="['chat-row', row.startsBlock ? 'row-gap' : '']"
          >
            <div
              :class="sliceClass(row)"
              :data-message-id="row.msg?.id"
            >
              <!-- User or system message: its own bubble -->
              <MessageItem
                v-if="row.kind === 'standalone' && row.msg"
                :message="row.msg"
                @open-task-detail="emit('open-task-detail', $event)"
                @open-tool-detail="emit('open-tool-detail', $event)"
              />

              <!-- Turn header -->
              <div
                v-else-if="row.kind === 'turn-header'"
                class="flex items-center gap-2 assistant-turn-header"
              >
                <div class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium bg-surface-300 dark:bg-surface-600 text-surface-700 dark:text-surface-200">
                  C
                </div>
                <span class="font-medium text-sm text-surface-700 dark:text-surface-300">
                  Claude
                </span>
                <span class="text-xs text-surface-400 dark:text-surface-500">
                  {{ formatTime(row.timestamp ?? 0) }}
                </span>
              </div>

              <!-- Turn content -->
              <div
                v-else-if="row.kind === 'turn-item' && row.msg"
                :class="row.depth > 0 ? 'nested-agent-item' : ''"
                :style="row.depth > 0 ? { paddingLeft: (row.depth * 0.75) + 'rem' } : undefined"
              >
                <MessageItem
                  :message="row.msg"
                  :child-count="row.childCount"
                  :is-expanded="row.isExpanded"
                  grouped
                  @open-task-detail="emit('open-task-detail', $event)"
                  @open-tool-detail="emit('open-tool-detail', $event)"
                  @toggle-agent-expand="toggleAgentExpand"
                />
              </div>

              <!-- Trailing spinner: sits under the last rendered content so the
                   user can see the turn is still running on long answers -->
              <div
                v-else-if="row.kind === 'turn-spinner'"
                class="flex items-center gap-2 assistant-turn-trailing-spinner"
              >
                <Spinner
                  size="sm"
                  class="text-primary-500"
                />
              </div>

              <!-- Thinking placeholder: loading but no assistant output yet -->
              <div
                v-else-if="row.kind === 'thinking'"
                class="flex items-center gap-2"
              >
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
/*
 * Spacing between blocks is PADDING on the row wrapper, never margin.
 *
 * Virtualised geometry is the sum of measured row heights, and offsetHeight
 * excludes margins — so a margin-based gap would make every offset drift by
 * the number of gaps above it, and the further down the conversation the
 * worse it would get. Padding on the outer wrapper is included in the
 * measurement and sits outside the bubble, so the gap stays uncoloured.
 */
.row-gap {
  padding-top: calc(var(--chat-line-height, 1.6) * 0.6rem);
}

.assistant-turn-header {
  margin-bottom: calc(var(--chat-line-height, 1.6) * 0.3rem);
}

/*
 * A turn bubble drawn as a stack of slices.
 *
 * A turn is no longer a single element — its header, content rows and
 * trailing spinner are separate rows so the window can cut between them — so
 * the bubble is assembled from each row's own edges. Side padding and borders
 * on every slice; the top and bottom are closed and rounded only on the
 * first and last. The result is continuous because the rows are adjacent in
 * normal flow with no margin between them.
 */
.turn-slice {
  padding-left: calc(var(--chat-line-height, 1.6) * 0.6rem);
  padding-right: calc(var(--chat-line-height, 1.6) * 0.6rem);
}

.turn-slice-first {
  padding-top: calc(var(--chat-line-height, 1.6) * 0.6rem);
}

.turn-slice-last {
  padding-bottom: calc(var(--chat-line-height, 1.6) * 0.6rem);
}

/* Interior spacing between a turn's rows, inside the bubble. */
.turn-slice-inner-gap {
  padding-top: calc(var(--chat-line-height, 1.6) * 0.25rem);
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
