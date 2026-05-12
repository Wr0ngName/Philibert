<script setup lang="ts">
/**
 * Conversation history sidebar component
 * Displays list of past conversations with load/delete/rename functionality
 */

import { storeToRefs } from 'pinia';
import { ref, nextTick } from 'vue';

import { useConversationsStore } from '../../stores/conversations';
import { formatRelativeDate } from '../../utils/date';
import Spinner from '../shared/Spinner.vue';
import Icon from '../shared/Icon.vue';

const conversationsStore = useConversationsStore();
const {
  sortedConversations,
  currentConversationId,
  isLoading,
  isSaving,
} = storeToRefs(conversationsStore);

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
        History
      </h2>
      <div class="flex items-center gap-2">
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

    <!-- Conversation List -->
    <div class="flex-1 overflow-y-auto">
      <!-- Loading state -->
      <div
        v-if="isLoading && sortedConversations.length === 0"
        class="flex items-center justify-center py-8"
      >
        <Spinner size="md" />
      </div>

      <!-- Empty state -->
      <div
        v-else-if="sortedConversations.length === 0"
        class="flex flex-col items-center justify-center py-8 px-4 text-center"
      >
        <Icon
          name="chat"
          size="xl"
          class="text-surface-300 dark:text-surface-600 mb-3"
          style="width: 3rem; height: 3rem;"
        />
        <p class="text-sm text-surface-500 dark:text-surface-400">
          No conversations yet
        </p>
        <p class="text-xs text-surface-400 dark:text-surface-500 mt-1">
          Start chatting to create your first conversation
        </p>
      </div>

      <!-- Conversations -->
      <div
        v-else
        class="divide-y divide-surface-100 dark:divide-surface-700"
      >
        <div
          v-for="conversation in sortedConversations"
          :key="conversation.id"
          class="group relative"
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
            }"
            @click="handleLoadConversation(conversation.id)"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="flex-1 min-w-0">
                <p
                  class="text-sm font-medium truncate"
                  :class="
                    currentConversationId === conversation.id
                      ? 'text-primary-700 dark:text-primary-300'
                      : 'text-surface-800 dark:text-surface-200'
                  "
                >
                  {{ conversation.title || 'New Conversation' }}
                </p>
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
    </div>
  </div>
</template>
