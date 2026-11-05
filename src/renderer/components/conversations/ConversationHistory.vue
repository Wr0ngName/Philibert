<script setup lang="ts">
/**
 * Conversation history sidebar component
 * Displays list of past conversations with load/delete/rename functionality
 */

import { storeToRefs } from 'pinia';
import { ref, computed, nextTick, onBeforeUnmount, watch } from 'vue';

import { useConversationsStore } from '../../stores/conversations';
import { useChatStore } from '../../stores/chat';
import { formatRelativeDate } from '../../utils/date';
import Spinner from '../shared/Spinner.vue';
import Icon from '../shared/Icon.vue';

const conversationsStore = useConversationsStore();
const {
  listedConversations,
  newDiscussionRow,
  listView,
  listHasMore,
  loadingMoreConversations,
  archivedCount,
  listRevealCount,
  currentConversationId,
  isLoading,
  isSaving,
} = storeToRefs(conversationsStore);

const showingArchive = computed(() => listView.value === 'archived');

/*
 * Infinite scrolling: a marker after the last row asks for the next page
 * when it comes within reach of the list's bottom edge. Watched again after
 * each page, because the observer only reports a change: a page too short to
 * push the marker out of reach would otherwise be the last one asked for.
 */
const scroller = ref<HTMLElement | null>(null);
const endMarker = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;

/** How close to the bottom the next page is asked for, so it is there before it is needed. */
const LOAD_AHEAD = '200px';

function watchEnd() {
  observer?.disconnect();
  observer = null;
  if (!scroller.value || !endMarker.value || !listHasMore.value) return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    },
    { root: scroller.value, rootMargin: `0px 0px ${LOAD_AHEAD} 0px` },
  );
  observer.observe(endMarker.value);
}

async function loadMore() {
  await conversationsStore.loadMoreConversations();
  await nextTick();
  watchEnd();
}

watch([endMarker, listHasMore], () => watchEnd(), { flush: 'post' });
onBeforeUnmount(() => observer?.disconnect());

/**
 * The open discussion's row brought into sight when the store has brought the
 * list to it (listRevealCount) — opened from search, say, far down the list
 * or in the archive. Not on every change to the list: a row moving as its
 * discussion is written in, or a page arriving as the user scrolls, must not
 * pull the list away from where the user is reading it.
 */
watch(
  listRevealCount,
  async () => {
    await nextTick();
    const id = currentConversationId.value;
    if (!id || !scroller.value) return;
    const row = [...scroller.value.querySelectorAll<HTMLElement>('[data-conversation-id]')].find(
      (element) => element.dataset.conversationId === id,
    );
    row?.scrollIntoView({ block: 'nearest' });
  },
  { flush: 'post' },
);

/** A discussion just started: its row, at the top, brought into sight. */
const newDiscussionRowEl = ref<HTMLElement | null>(null);
watch(
  () => newDiscussionRow.value?.id,
  (id) => {
    if (id) newDiscussionRowEl.value?.scrollIntoView({ block: 'nearest' });
  },
  { flush: 'post' },
);

async function showView(view: 'active' | 'archived') {
  confirmDeleteId.value = null;
  renamingId.value = null;
  await conversationsStore.showListView(view);
  scroller.value?.scrollTo({ top: 0 });
}

async function handleArchiveClick(id: string, event: Event) {
  event.stopPropagation();
  await conversationsStore.setConversationArchived(id, !showingArchive.value);
}

const chatStore = useChatStore();
const {
  activeQueryCount,
  maxConcurrentQueries,
  processingQueryCount,
} = storeToRefs(chatStore);

// Compact activity / resource-limit indicator shown right under the header,
// replacing the standalone banner that used to eat vertical space above chat.
const activityLevel = computed<'none' | 'info' | 'warn' | 'error'>(() => {
  if (processingQueryCount.value >= maxConcurrentQueries.value) return 'error';
  if (processingQueryCount.value >= maxConcurrentQueries.value - 1) return 'warn';
  if (processingQueryCount.value > 0) return 'info';
  return 'none';
});

// Compact count only ("N/M"). State is conveyed by chip color; verbose
// labels overflow the sidebar header.
const activityText = computed(() =>
  `${processingQueryCount.value}/${maxConcurrentQueries.value}`
);

function needsAttention(conversationId: string): boolean {
  return chatStore.conversationHasPendingActions(conversationId);
}

function isConversationActive(conversationId: string): boolean {
  return chatStore.isConversationLoading(conversationId);
}

const deletingId = ref<string | null>(null);
const confirmDeleteId = ref<string | null>(null);
const renamingId = ref<string | null>(null);
const renameValue = ref('');
// Store refs for rename inputs by conversation id
const renameInputRefs = ref<Map<string, HTMLInputElement>>(new Map());

async function handleNewConversation() {
  // Save current conversation before creating new one
  // Note: With multi-conversation support, streaming continues in background
  await conversationsStore.saveCurrentConversation();
  conversationsStore.createNewConversation();
}

async function handleLoadConversation(id: string) {
  if (id === currentConversationId.value) {
    return;
  }
  // Use switchConversation which handles saving and loading properly
  // With multi-conversation support, streaming continues in background
  await conversationsStore.switchConversation(id);
}

function handleDeleteClick(id: string, event: Event) {
  event.stopPropagation();
  confirmDeleteId.value = id;
}

async function handleConfirmDelete(id: string) {
  deletingId.value = id;
  await conversationsStore.deleteConversation(id);
  deletingId.value = null;
  confirmDeleteId.value = null;
}

function handleCancelDelete() {
  confirmDeleteId.value = null;
}

function handleRenameClick(id: string, currentTitle: string, event: Event) {
  event.stopPropagation();
  renamingId.value = id;
  renameValue.value = currentTitle || '';
  // Focus input after it's rendered
  nextTick(() => {
    const input = renameInputRefs.value.get(id);
    if (input) {
      input.focus();
      input.select();
    }
  });
}

function setRenameInputRef(id: string, el: HTMLInputElement | null) {
  if (el) {
    renameInputRefs.value.set(id, el);
  } else {
    renameInputRefs.value.delete(id);
  }
}

async function handleRenameSubmit(id: string) {
  if (renameValue.value.trim()) {
    await conversationsStore.renameConversation(id, renameValue.value.trim());
  }
  renamingId.value = null;
  renameValue.value = '';
}

function handleRenameCancel() {
  renamingId.value = null;
  renameValue.value = '';
}

function handleRenameKeydown(event: KeyboardEvent, id: string) {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleRenameSubmit(id);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    handleRenameCancel();
  }
}
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Header -->
    <div class="flex items-center justify-between p-3 border-b border-surface-200 dark:border-surface-700">
      <h2 class="text-sm font-semibold text-surface-700 dark:text-surface-300">
        Discussions
      </h2>
      <div class="flex items-center gap-2">
        <!-- Compact activity / resource-limit indicator (replaces the top-of-chat banner) -->
        <span
          v-if="activityLevel !== 'none'"
          class="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded"
          :class="{
            'text-blue-600 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/30': activityLevel === 'info',
            'text-yellow-700 dark:text-yellow-300 bg-yellow-50 dark:bg-yellow-900/30': activityLevel === 'warn',
            'text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/30': activityLevel === 'error',
          }"
          :title="`${processingQueryCount}/${maxConcurrentQueries} runs (${activeQueryCount} sessions open)`"
        >
          <Spinner
            v-if="activityLevel === 'info'"
            size="xs"
          />
          <Icon
            v-else
            name="warning"
            size="xs"
          />
          {{ activityText }}
        </span>
        <Spinner
          v-if="isSaving"
          size="sm"
          class="text-surface-400"
        />
        <button
          class="p-1.5 rounded-md hover:bg-surface-100 dark:hover:bg-surface-700 text-surface-600 dark:text-surface-400 transition-colors"
          title="New conversation"
          @click="handleNewConversation"
        >
          <Icon
            name="plus"
            size="sm"
          />
        </button>
      </div>
    </div>

    <!-- Active or archived -->
    <div
      class="flex gap-1 px-3 py-1.5 border-b border-surface-200 dark:border-surface-700 text-xs"
      role="tablist"
      aria-label="Which discussions to list"
    >
      <button
        v-for="view in (['active', 'archived'] as const)"
        :key="view"
        role="tab"
        :aria-selected="listView === view"
        :class="[
          'px-2 py-0.5 rounded-md transition-colors',
          listView === view
            ? 'bg-surface-200 dark:bg-surface-700 text-surface-800 dark:text-surface-100 font-medium'
            : 'text-surface-500 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800',
        ]"
        @click="showView(view)"
      >
        {{ view === 'active' ? 'Active' : `Archived${archivedCount > 0 ? ` (${archivedCount})` : ''}` }}
      </button>
    </div>

    <!-- Conversation List -->
    <div
      ref="scroller"
      class="flex-1 overflow-y-auto"
    >
      <!-- Loading state -->
      <div
        v-if="isLoading && listedConversations.length === 0 && !newDiscussionRow"
        class="flex items-center justify-center py-8"
      >
        <Spinner size="md" />
      </div>

      <!-- Empty state -->
      <div
        v-else-if="listedConversations.length === 0 && !newDiscussionRow"
        class="flex flex-col items-center justify-center py-8 px-4 text-center"
      >
        <Icon
          :name="showingArchive ? 'archive' : 'chat'"
          size="xl"
          class="text-surface-300 dark:text-surface-600 mb-3"
          style="width: 3rem; height: 3rem;"
        />
        <template v-if="showingArchive">
          <p class="text-sm text-surface-500 dark:text-surface-400">
            No archived discussions
          </p>
          <p class="text-xs text-surface-400 dark:text-surface-500 mt-1">
            Archive one from its menu, or let inactive ones be archived in Settings
          </p>
        </template>
        <template v-else>
          <p class="text-sm text-surface-500 dark:text-surface-400">
            No conversations yet
          </p>
          <p class="text-xs text-surface-400 dark:text-surface-500 mt-1">
            Start chatting to create your first conversation
          </p>
        </template>
      </div>

      <!-- Conversations -->
      <div
        v-else
        class="divide-y divide-surface-100 dark:divide-surface-700"
      >
        <!-- The discussion just started, open and not saved yet: listed so
             the list shows where the user is. Its own row once saved. -->
        <div
          v-if="newDiscussionRow"
          ref="newDiscussionRowEl"
          class="new-discussion-row px-3 py-2.5 bg-primary-50 dark:bg-primary-900/20"
          :data-conversation-id="newDiscussionRow.id"
          aria-current="true"
        >
          <p class="text-sm font-medium italic truncate text-primary-700 dark:text-primary-300">
            New discussion
          </p>
          <p class="text-xs text-surface-500 dark:text-surface-400 mt-0.5 truncate">
            {{ newDiscussionRow.workingDirectory }}
          </p>
        </div>
        <div
          v-for="conversation in listedConversations"
          :key="conversation.id"
          class="group relative"
          :data-conversation-id="conversation.id"
        >
          <!-- Confirmation overlay -->
          <div
            v-if="confirmDeleteId === conversation.id"
            class="absolute inset-0 bg-red-50 dark:bg-red-900/20 flex items-center justify-center gap-2 z-10"
          >
            <button
              class="px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 rounded-sm transition-colors"
              :disabled="deletingId === conversation.id"
              @click="handleConfirmDelete(conversation.id)"
            >
              <span v-if="deletingId === conversation.id">
                <Spinner size="xs" />
              </span>
              <span v-else>Delete</span>
            </button>
            <button
              class="px-2 py-1 text-xs font-medium text-surface-600 dark:text-surface-400 hover:bg-surface-200 dark:hover:bg-surface-700 rounded-sm transition-colors"
              @click="handleCancelDelete"
            >
              Cancel
            </button>
          </div>

          <!-- Rename overlay -->
          <div
            v-if="renamingId === conversation.id"
            class="absolute inset-0 bg-white dark:bg-surface-800 flex items-center px-3 z-10"
          >
            <input
              :ref="(el) => setRenameInputRef(conversation.id, el as HTMLInputElement)"
              v-model="renameValue"
              type="text"
              class="flex-1 px-2 py-1 text-sm border border-primary-300 dark:border-primary-600 rounded-sm bg-white dark:bg-surface-700 text-surface-800 dark:text-surface-200 focus:outline-hidden focus:ring-1 focus:ring-primary-500"
              placeholder="Enter title..."
              @keydown="handleRenameKeydown($event, conversation.id)"
              @blur="handleRenameSubmit(conversation.id)"
            >
          </div>

          <!-- Conversation item -->
          <button
            class="w-full text-left px-3 py-2.5 hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors"
            :class="{
              'bg-primary-50 dark:bg-primary-900/20': currentConversationId === conversation.id,
              'bg-amber-50/50 dark:bg-amber-900/10': needsAttention(conversation.id) && currentConversationId !== conversation.id,
            }"
            @click="handleLoadConversation(conversation.id)"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1.5">
                  <!-- Pending action indicator -->
                  <span
                    v-if="needsAttention(conversation.id)"
                    class="shrink-0 w-2 h-2 rounded-full bg-amber-500 animate-pulse"
                    title="Action required"
                  />
                  <!-- Active query indicator -->
                  <Spinner
                    v-else-if="isConversationActive(conversation.id) && currentConversationId !== conversation.id"
                    size="xs"
                    class="shrink-0 text-primary-400"
                  />
                  <p
                    class="text-sm font-medium truncate"
                    :class="
                      currentConversationId === conversation.id
                        ? 'text-primary-700 dark:text-primary-300'
                        : needsAttention(conversation.id)
                          ? 'text-amber-700 dark:text-amber-300'
                          : 'text-surface-800 dark:text-surface-200'
                    "
                  >
                    {{ conversation.title || 'New Conversation' }}
                  </p>
                </div>
                <p class="text-xs text-surface-500 dark:text-surface-400 mt-0.5 truncate">
                  {{ conversation.workingDirectory }}
                </p>
              </div>
              <div class="flex items-center gap-1">
                <!-- DateTime - visible by default, hidden on hover -->
                <span class="text-xs text-surface-400 dark:text-surface-500 whitespace-nowrap group-hover:hidden">
                  {{ formatRelativeDate(conversation.updatedAt) }}
                </span>
                <!-- Action buttons - hidden by default, visible on hover -->
                <div class="hidden group-hover:flex items-center gap-1">
                  <!-- Rename button -->
                  <button
                    class="p-1 rounded-sm hover:bg-surface-200 dark:hover:bg-surface-600 text-surface-400 hover:text-primary-500 dark:hover:text-primary-400 transition-colors"
                    title="Rename conversation"
                    @click="handleRenameClick(conversation.id, conversation.title, $event)"
                  >
                    <Icon
                      name="edit"
                      size="xs"
                    />
                  </button>
                  <!-- Archive, or bring back -->
                  <button
                    class="p-1 rounded-sm hover:bg-surface-200 dark:hover:bg-surface-600 text-surface-400 hover:text-primary-500 dark:hover:text-primary-400 transition-colors"
                    :title="showingArchive ? 'Bring back from the archive' : 'Archive conversation'"
                    @click="handleArchiveClick(conversation.id, $event)"
                  >
                    <Icon
                      :name="showingArchive ? 'restore' : 'archive'"
                      size="xs"
                    />
                  </button>
                  <!-- Delete button -->
                  <button
                    class="p-1 rounded-sm hover:bg-surface-200 dark:hover:bg-surface-600 text-surface-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                    title="Delete conversation"
                    @click="handleDeleteClick(conversation.id, $event)"
                  >
                    <Icon
                      name="trash"
                      size="xs"
                    />
                  </button>
                </div>
              </div>
            </div>
          </button>
        </div>
      </div>

      <!-- The next page is asked for when this comes within reach -->
      <div
        v-if="listHasMore && listedConversations.length > 0"
        ref="endMarker"
        class="flex items-center justify-center py-3"
        data-testid="list-end-marker"
      >
        <Spinner
          v-if="loadingMoreConversations"
          size="sm"
          class="text-surface-400"
        />
      </div>
    </div>
  </div>
</template>
