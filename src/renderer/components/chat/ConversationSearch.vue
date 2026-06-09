<script setup lang="ts">
/**
 * Conversation search modal.
 *
 * Searches messages in the active conversation OR every saved conversation,
 * runs server-side (ConversationService.search) so the renderer doesn't
 * have to load all conversation files into memory. Click a result to load
 * the source conversation; we don't auto-scroll to the message yet, but
 * the conversation switch is enough to find context.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';

import type { ConversationSearchResult, ConversationSearchScope } from '@shared/types';

import { useChatStore } from '../../stores/chat';
import { useConversationsStore } from '../../stores/conversations';
import { logger } from '../../utils/logger';
import Icon from '../shared/Icon.vue';
import Modal from '../shared/Modal.vue';
import Spinner from '../shared/Spinner.vue';

interface Props {
  open: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{ (e: 'close'): void }>();

const conversationsStore = useConversationsStore();
const chatStore = useChatStore();
const { currentConversationId } = storeToRefs(conversationsStore);

const query = ref('');
const scope = ref<ConversationSearchScope>('current');
const results = ref<ConversationSearchResult[]>([]);
const isSearching = ref(false);
const searchError = ref('');
const inputRef = ref<HTMLInputElement | null>(null);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function close(): void {
  emit('close');
}

async function runSearch(): Promise<void> {
  const q = query.value.trim();
  if (!q) {
    results.value = [];
    searchError.value = '';
    return;
  }
  isSearching.value = true;
  searchError.value = '';
  try {
    results.value = await window.electron.conversation.search(
      q,
      scope.value,
      currentConversationId.value ?? null,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Search failed', { error: msg });
    searchError.value = msg;
    results.value = [];
  } finally {
    isSearching.value = false;
  }
}

function scheduleSearch(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void runSearch();
  }, 200);
}

watch([query, scope], () => {
  scheduleSearch();
});

// Reset and focus when opening
watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return;
    query.value = '';
    results.value = [];
    searchError.value = '';
    scope.value = currentConversationId.value ? 'current' : 'all';
    await nextTick();
    inputRef.value?.focus();
  },
);

onMounted(() => {
  if (props.open) {
    inputRef.value?.focus();
  }
});

async function openResult(result: ConversationSearchResult): Promise<void> {
  close();
  // Set the scroll target FIRST so the ChatWindow watcher can pick it up
  // regardless of whether we need to switch conversations or not.
  chatStore.pendingScrollMessageId = result.messageId;
  if (result.conversationId !== currentConversationId.value) {
    try {
      await conversationsStore.switchConversation(result.conversationId);
    } catch (err) {
      logger.warn('Failed to switch to result conversation', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

const hasResults = computed(() => results.value.length > 0);
const showEmptyState = computed(() => !isSearching.value && query.value.trim() && !hasResults.value && !searchError.value);

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}
</script>

<template>
  <Modal
    :open="open"
    title="Search messages"
    @close="close"
  >
    <div class="flex flex-col gap-3 min-h-[300px]">
      <!-- Scope toggle -->
      <div class="flex items-center gap-2 text-xs">
        <button
          type="button"
          :class="[
            'px-2.5 py-1 rounded-full border transition-colors',
            scope === 'current'
              ? 'bg-primary-500 text-white border-primary-500'
              : 'bg-surface-100 dark:bg-surface-800 text-surface-700 dark:text-surface-200 border-surface-300 dark:border-surface-600 hover:bg-surface-200 dark:hover:bg-surface-700',
          ]"
          :disabled="!currentConversationId"
          @click="scope = 'current'"
        >
          Current discussion
        </button>
        <button
          type="button"
          :class="[
            'px-2.5 py-1 rounded-full border transition-colors',
            scope === 'all'
              ? 'bg-primary-500 text-white border-primary-500'
              : 'bg-surface-100 dark:bg-surface-800 text-surface-700 dark:text-surface-200 border-surface-300 dark:border-surface-600 hover:bg-surface-200 dark:hover:bg-surface-700',
          ]"
          @click="scope = 'all'"
        >
          All discussions
        </button>
      </div>

      <!-- Input -->
      <div class="relative">
        <Icon
          name="search"
          size="sm"
          class="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-400 dark:text-surface-500"
        />
        <input
          ref="inputRef"
          v-model="query"
          type="text"
          placeholder="Type to search…"
          class="w-full pl-8 pr-3 py-1.5 text-sm rounded-md border border-surface-300 dark:border-surface-600 bg-surface-50 dark:bg-surface-900 text-surface-800 dark:text-surface-200 focus:outline-hidden focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
        >
      </div>

      <!-- Results -->
      <div class="flex-1 min-h-[200px] max-h-[60vh] overflow-y-auto">
        <div
          v-if="isSearching"
          class="flex items-center justify-center py-6 text-sm text-surface-500 dark:text-surface-400 gap-2"
        >
          <Spinner size="sm" />
          Searching…
        </div>

        <div
          v-else-if="searchError"
          class="px-2 py-1.5 text-xs text-red-600 dark:text-red-400"
        >
          {{ searchError }}
        </div>

        <div
          v-else-if="showEmptyState"
          class="px-2 py-6 text-center text-sm text-surface-500 dark:text-surface-400"
        >
          No matches.
        </div>

        <ul
          v-else-if="hasResults"
          class="space-y-1"
        >
          <li
            v-for="result in results"
            :key="`${result.conversationId}:${result.messageId}`"
          >
            <button
              type="button"
              class="w-full text-left rounded-md border border-surface-200 dark:border-surface-700 px-3 py-2 hover:bg-surface-100 dark:hover:bg-surface-700 transition-colors"
              @click="openResult(result)"
            >
              <div class="flex items-center gap-2 text-[11px] text-surface-500 dark:text-surface-400 mb-0.5">
                <span class="font-medium text-surface-700 dark:text-surface-300 truncate max-w-[60%]">
                  {{ result.conversationTitle }}
                </span>
                <span class="uppercase tracking-wide">{{ result.role }}</span>
                <span class="ml-auto">{{ formatTime(result.timestamp) }}</span>
              </div>
              <div class="text-sm text-surface-800 dark:text-surface-200 whitespace-pre-wrap break-words">
                {{ result.snippet }}
              </div>
            </button>
          </li>
        </ul>

        <div
          v-else
          class="px-2 py-6 text-center text-sm text-surface-500 dark:text-surface-400"
        >
          Type a query to search messages.
        </div>
      </div>
    </div>
  </Modal>
</template>
