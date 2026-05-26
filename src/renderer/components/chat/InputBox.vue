<script setup lang="ts">
/**
 * Chat input box component
 */

import { ref, computed } from 'vue';
import { storeToRefs } from 'pinia';

import type { SlashCommandInfo } from '@shared/types';

import { CONSTANTS } from '../../constants/app';
import { useClaudeChat } from '../../composables/useClaudeChat';
import { useChatStore } from '../../stores/chat';
import { useFilesStore } from '../../stores/files';
import { useSettingsStore } from '../../stores/settings';
import Button from '../shared/Button.vue';
import Icon from '../shared/Icon.vue';
import CommandAutocomplete from './CommandAutocomplete.vue';

const emit = defineEmits<{
  (e: 'send', message: string): void;
  (e: 'abort'): void;
}>();

const chatStore = useChatStore();
const filesStore = useFilesStore();
const settingsStore = useSettingsStore();
const { slashCommands } = useClaudeChat();

const { isLoading, hasMessages } = storeToRefs(chatStore);
const { hasAuth, executionMode } = storeToRefs(settingsStore);
const { hasWorkingDirectory } = storeToRefs(filesStore);

const inputRef = ref<HTMLTextAreaElement | null>(null);
const autocompleteRef = ref<InstanceType<typeof CommandAutocomplete> | null>(null);
const message = ref('');

const canSend = computed(() => {
  return message.value.trim().length > 0 && hasAuth.value && hasWorkingDirectory.value && !isLoading.value;
});

const placeholder = computed(() => {
  if (!hasAuth.value) {
    return 'Please log in via Settings (gear icon in top right) to start chatting...';
  }
  if (!hasWorkingDirectory.value) {
    return 'Please select a working directory first...';
  }
  return 'Ask Claude anything... (try /compact, /help, /cost)';
});

// Disable input when not authenticated or loading
const isDisabled = computed(() => {
  return !hasAuth.value || isLoading.value;
});

// Check if current input looks like a CLI command
const isTypingCommand = computed(() => {
  return message.value.trim().startsWith('/');
});

// Show autocomplete when typing a command and commands are available
const showAutocomplete = computed(() => {
  return isTypingCommand.value && slashCommands.value.length > 0 && !isLoading.value;
});

function handleSubmit(): void {
  if (canSend.value) {
    emit('send', message.value.trim());
    message.value = '';
    // Reset textarea height
    if (inputRef.value) {
      inputRef.value.style.height = 'auto';
    }
  }
}

function handleKeydown(event: KeyboardEvent): void {
  // Let autocomplete handle navigation when shown
  if (showAutocomplete.value && autocompleteRef.value) {
    const handled = autocompleteRef.value.handleKeydown(event);
    if (handled) return;
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleSubmit();
  }
}

/**
 * Handle command selection from autocomplete
 */
function handleCommandSelect(command: SlashCommandInfo): void {
  // Replace input with selected command
  message.value = `/${command.name} `;
  // Focus input and move cursor to end
  if (inputRef.value) {
    inputRef.value.focus();
    // Use setTimeout to ensure the value is updated first
    setTimeout(() => {
      if (inputRef.value) {
        inputRef.value.selectionStart = inputRef.value.selectionEnd = message.value.length;
      }
    }, 0);
  }
}

function handleAbort() {
  emit('abort');
}

// Auto-resize textarea
function handleInput(event: Event) {
  const textarea = event.target as HTMLTextAreaElement;
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, CONSTANTS.UI.TEXTAREA_MAX_HEIGHT) + 'px';
}
</script>

<template>
  <div class="border-t border-surface-200 dark:border-surface-700 p-4 bg-white dark:bg-surface-800">
    <div class="flex gap-3 items-start">
      <div class="flex-1">
        <div class="relative">
          <!-- Command autocomplete dropdown -->
          <CommandAutocomplete
            ref="autocompleteRef"
            :commands="slashCommands"
            :input-value="message"
            :show="showAutocomplete"
            :has-conversation="hasMessages"
            @select="handleCommandSelect"
          />

          <textarea
            ref="inputRef"
            v-model="message"
            :placeholder="placeholder"
            :disabled="isDisabled"
            class="input-base resize-none min-h-[44px] max-h-[200px] pr-4"
            :class="{ 'opacity-60 cursor-not-allowed': isDisabled }"
            rows="1"
            @keydown="handleKeydown"
            @input="handleInput"
          />
        </div>

        <!-- Hints -->
        <div class="flex items-center justify-between mt-1.5 text-xs text-surface-400 dark:text-surface-500">
          <span
            v-if="showAutocomplete"
            class="text-primary-500 dark:text-primary-400"
          >
            Use ↑↓ to navigate, Tab/Enter to select
          </span>
          <span
            v-else-if="isTypingCommand"
            class="text-primary-500 dark:text-primary-400"
          >
            Type a command name...
          </span>
          <span v-else>Press Enter to send, Shift+Enter for new line</span>
          <div class="flex items-center gap-2">
            <span
              v-if="executionMode === 'channel'"
              class="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800"
            >Channel</span>
            <span v-if="message.length > 0">{{ message.length }} characters</span>
          </div>
        </div>
      </div>

      <div class="flex gap-2 h-[44px] items-center">
        <Button
          v-if="isLoading"
          variant="danger"
          size="md"
          @click="handleAbort"
        >
          <Icon
            name="close"
            size="sm"
            class="mr-1"
          />
          Stop
        </Button>

        <Button
          v-else
          variant="primary"
          size="md"
          :disabled="!canSend"
          @click="handleSubmit"
        >
          <Icon
            name="send"
            size="sm"
            class="mr-1"
          />
          Send
        </Button>
      </div>
    </div>
  </div>
</template>
