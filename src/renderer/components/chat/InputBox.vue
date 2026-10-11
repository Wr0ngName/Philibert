<script setup lang="ts">
/**
 * Chat input box component
 */

import { ref, computed, onMounted, nextTick } from 'vue';
import { storeToRefs } from 'pinia';

import type { SlashCommandInfo } from '@shared/types';

import { CONSTANTS } from '../../constants/app';
import { useClaudeChat } from '../../composables/useClaudeChat';
import { useSpeechInput } from '../../composables/useSpeechInput';
import { useChatStore } from '../../stores/chat';
import { useConversationsStore } from '../../stores/conversations';
import { useFilesStore } from '../../stores/files';
import { useSettingsStore } from '../../stores/settings';
import Button from '../shared/Button.vue';
import Icon from '../shared/Icon.vue';
import CommandAutocomplete from './CommandAutocomplete.vue';

const emit = defineEmits<{
  (e: 'send', message: string): void;
  /** Hold this prompt until the running turn finishes. */
  (e: 'queue', message: string): void;
  /** Send what is queued now, without waiting for a turn to end. */
  (e: 'release-queue'): void;
  /** Forget one queued prompt. */
  (e: 'unqueue', promptId: string): void;
  (e: 'abort'): void;
}>();

const chatStore = useChatStore();
const filesStore = useFilesStore();
const settingsStore = useSettingsStore();
const conversationsStore = useConversationsStore();
const { slashCommands } = useClaudeChat();

const { isLoading, hasMessages, queuedPrompts } = storeToRefs(chatStore);
const { hasAuth, executionMode } = storeToRefs(settingsStore);
const { hasWorkingDirectory } = storeToRefs(filesStore);
const { currentModeMismatch } = storeToRefs(conversationsStore);

const inputRef = ref<HTMLTextAreaElement | null>(null);
const autocompleteRef = ref<InstanceType<typeof CommandAutocomplete> | null>(null);
const message = ref('');

// ── Dictation ──────────────────────────────────────────────────────────────
const { speechEnabled, speechModel, speechLanguage } = storeToRefs(settingsStore);
const speech = useSpeechInput();

/** Whether this build actually has a whisper binary to transcribe with. */
const speechAvailable = ref(false);

onMounted(async () => {
  // A build made before the vendor job ran has no binary; asking once on mount
  // keeps the button from appearing where it could only fail.
  speechAvailable.value = (await window.electron.speech.getAvailability()).available;
});

const micVisible = computed(() => speechEnabled.value && speechAvailable.value);

const micTitle = computed(() => {
  if (speech.isRecording.value) return 'Stop recording and transcribe';
  if (speech.phase.value === 'transcribing') return 'Transcribing…';
  return 'Dictate a message';
});

/** Progress line shown in place of the keyboard hint while dictating. */
const speechStatus = computed(() => {
  const progress = speech.downloadProgress.value;
  if (progress) {
    const received = Math.round(progress.receivedBytes / (1024 * 1024));
    if (progress.totalBytes) {
      const total = Math.round(progress.totalBytes / (1024 * 1024));
      return `Downloading speech model… ${received}/${total} MB`;
    }
    return `Downloading speech model… ${received} MB`;
  }
  if (speech.isRecording.value) return 'Recording — click the stop button to transcribe';
  if (speech.phase.value === 'transcribing') return 'Transcribing…';
  return null;
});

/**
 * Insert the transcript at the caret rather than replacing the box, so
 * dictation can be mixed with typing.
 */
function insertTranscript(text: string): void {
  const textarea = inputRef.value;
  const existing = message.value;

  if (!textarea) {
    message.value = existing ? `${existing} ${text}` : text;
    return;
  }

  const start = textarea.selectionStart ?? existing.length;
  const end = textarea.selectionEnd ?? existing.length;
  const before = existing.slice(0, start);
  const after = existing.slice(end);
  // Keep a space between dictated text and whatever it lands against.
  const prefix = before && !/\s$/.test(before) ? ' ' : '';
  const suffix = after && !/^\s/.test(after) ? ' ' : '';
  message.value = `${before}${prefix}${text}${suffix}${after}`;

  const caret = (before + prefix + text).length;
  void nextTick(() => {
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  });
}

async function toggleDictation(): Promise<void> {
  if (speech.isRecording.value) {
    const text = await speech.stopAndTranscribe(speechModel.value, speechLanguage.value);
    if (text) insertTranscript(text);
    return;
  }
  await speech.start();
}

/**
 * Whether the written prompt can go anywhere at all.
 *
 * Deliberately no longer includes `!isLoading`. A running turn used to make
 * this false, which meant Enter did nothing and the Send button was replaced
 * by Stop: the only way to say the next thing was to abort the turn, killing
 * the run and every agent in it. A turn in flight now changes where the prompt
 * goes — the queue instead of the wire — not whether it is accepted.
 *
 * The other conditions are real blocks and stay: without auth or a working
 * directory the prompt cannot be sent later either, and a mode mismatch means
 * the SDK could not resume this conversation at all.
 */
const canSubmit = computed(() => {
  return message.value.trim().length > 0
    && hasAuth.value
    && hasWorkingDirectory.value
    && !currentModeMismatch.value;
});

/** A submission now would be held rather than sent. */
const willQueue = computed(() => isLoading.value);

const hasQueuedPrompts = computed(() => queuedPrompts.value.length > 0);

const placeholder = computed(() => {
  if (!hasAuth.value) {
    return 'Please log in via Settings (gear icon in top right) to start chatting...';
  }
  if (!hasWorkingDirectory.value) {
    return 'Please select a working directory first...';
  }
  if (currentModeMismatch.value) {
    return `This conversation was started in ${currentModeMismatch.value.conversationMode} mode — switch back or continue in ${currentModeMismatch.value.currentMode} mode to send.`;
  }
  return 'Ask Claude anything... (try /compact, /help, /cost)';
});

// Disable input when not authenticated OR when the conversation belongs to
// a different execution mode (the SDK/CLI can't resume across modes, so a
// send would fail; the user must acknowledge via the banner first).
const isDisabled = computed(() => {
  return !hasAuth.value || !!currentModeMismatch.value;
});

// Check if current input looks like a CLI command
const isTypingCommand = computed(() => {
  return message.value.trim().startsWith('/');
});

// Show autocomplete when typing a command and commands are available.
// Stays available while a query is loading so the user can draft slash
// commands for their next turn.
const showAutocomplete = computed(() => {
  return isTypingCommand.value && slashCommands.value.length > 0;
});

function handleSubmit(): void {
  if (!canSubmit.value) return;

  const prompt = message.value.trim();
  if (willQueue.value) {
    emit('queue', prompt);
  } else {
    emit('send', prompt);
  }
  message.value = '';
  // Reset textarea height
  if (inputRef.value) {
    inputRef.value.style.height = 'auto';
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
    <!--
      Prompts written during a turn, waiting for it to finish.

      Shown because a queue the user cannot see is worse than no queue: they
      would have no way to tell whether Enter did anything, what is about to be
      sent, or in what order. Each entry can be removed, and when nothing is
      running there is a button to send them now — the case that needs it is
      Stop, which honours the abort and so leaves the queue with no turn ending
      later to release it.
    -->
    <div
      v-if="hasQueuedPrompts"
      class="mb-3 rounded-lg border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-900/40"
    >
      <div class="flex items-center justify-between px-3 py-2 border-b border-surface-200 dark:border-surface-700">
        <span class="flex items-center gap-1.5 text-xs font-medium text-surface-600 dark:text-surface-300">
          <Icon
            name="history"
            size="xs"
          />
          {{ queuedPrompts.length }} queued
          <span class="font-normal text-surface-400 dark:text-surface-500">
            {{ isLoading ? '· sent when this turn finishes' : '· waiting to be sent' }}
          </span>
        </span>
        <Button
          v-if="!isLoading"
          variant="ghost"
          size="sm"
          title="Send the queued prompts now"
          @click="emit('release-queue')"
        >
          Send now
        </Button>
      </div>
      <ul class="divide-y divide-surface-200 dark:divide-surface-700">
        <li
          v-for="prompt in queuedPrompts"
          :key="prompt.id"
          class="flex items-start gap-2 px-3 py-2"
        >
          <span class="flex-1 min-w-0 text-xs text-surface-700 dark:text-surface-200 whitespace-pre-wrap break-words line-clamp-3">{{ prompt.content }}</span>
          <button
            type="button"
            class="shrink-0 p-1 rounded text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 hover:bg-surface-200 dark:hover:bg-surface-700"
            :title="`Remove this queued prompt`"
            @click="emit('unqueue', prompt.id)"
          >
            <Icon
              name="close"
              size="xs"
            />
          </button>
        </li>
      </ul>
    </div>

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
          <span
            v-else-if="speechStatus"
            class="text-primary-500 dark:text-primary-400"
          >{{ speechStatus }}</span>
          <span
            v-else-if="speech.error.value"
            class="text-amber-600 dark:text-amber-400"
          >{{ speech.error.value }}</span>
          <span v-else-if="willQueue">Press Enter to queue for after this turn, Shift+Enter for new line</span>
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
        <!-- Dictation. Hidden unless enabled in settings and the build has a
             whisper binary, so a build without one offers nothing that cannot
             work. -->
        <Button
          v-if="micVisible"
          :variant="speech.isRecording.value ? 'danger' : 'secondary'"
          size="md"
          :disabled="isDisabled || speech.phase.value === 'transcribing'"
          :title="micTitle"
          @click="toggleDictation"
        >
          <Icon
            :name="speech.isRecording.value ? 'stop' : 'microphone'"
            size="sm"
          />
        </Button>

        <!-- Stop sits ALONGSIDE the submit button during a turn rather than
             replacing it. Replacing it was the whole problem: the only control
             available mid-turn was the one that kills the run. -->
        <Button
          v-if="isLoading"
          variant="danger"
          size="md"
          title="Stop this turn, ending the run and any agents in it"
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
          variant="primary"
          size="md"
          :disabled="!canSubmit"
          :title="willQueue
            ? 'Queue this prompt — it is sent when the current turn finishes'
            : 'Send this prompt'"
          @click="handleSubmit"
        >
          <!-- `history` is the clock glyph; there is no separate clock icon,
               and adding one would duplicate the same path. -->
          <Icon
            :name="willQueue ? 'history' : 'send'"
            size="sm"
            class="mr-1"
          />
          {{ willQueue ? 'Queue' : 'Send' }}
        </Button>
      </div>
    </div>
  </div>
</template>
