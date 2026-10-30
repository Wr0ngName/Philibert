<script setup lang="ts">
/**
 * Chat input box component
 */

import { ref, computed, onMounted, nextTick } from 'vue';
import { storeToRefs } from 'pinia';

import { IMAGE_MEDIA_TYPES, type MessageImage, type SlashCommandInfo } from '@shared/types';

import { CONSTANTS } from '../../constants/app';
import { useClaudeChat } from '../../composables/useClaudeChat';
import { useSpeechInput } from '../../composables/useSpeechInput';
import { useChatStore } from '../../stores/chat';
import { useConversationsStore } from '../../stores/conversations';
import { useFilesStore } from '../../stores/files';
import { useSettingsStore } from '../../stores/settings';
import { logger } from '../../utils/logger';
import Button from '../shared/Button.vue';
import ContextMenu, { type ContextMenuItem } from '../shared/ContextMenu.vue';
import Icon from '../shared/Icon.vue';
import CommandAutocomplete from './CommandAutocomplete.vue';

const emit = defineEmits<{
  (e: 'send', message: string, images?: MessageImage[]): void;
  /** Send this prompt into the running turn, for Claude to read at its next step. */
  (e: 'send-now', message: string, images?: MessageImage[]): void;
  /** Take back a prompt sent into the turn, before Claude reads it. */
  (e: 'take-back', uuid: string): void;
  /** Hold this prompt until the running turn finishes. */
  (e: 'queue', message: string, images?: MessageImage[]): void;
  /** Send what is queued now, without waiting for a turn to end. */
  (e: 'release-queue'): void;
  /** Forget one queued prompt. */
  (e: 'unqueue', promptId: string): void;
  (e: 'abort'): void;
  /** Stop the turn and every background task it left running. */
  (e: 'abort-everything'): void;
  /** Stop the background tasks, with no turn running to interrupt. */
  (e: 'stop-tasks'): void;
}>();

const chatStore = useChatStore();
const filesStore = useFilesStore();
const settingsStore = useSettingsStore();
const conversationsStore = useConversationsStore();
const { slashCommands } = useClaudeChat();

const {
  isLoading,
  hasMessages,
  queuedPrompts,
  deliveringPrompts,
  queueHeld,
  hasRunningBackgroundTasks,
  runningBackgroundTasksList,
} = storeToRefs(chatStore);
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
  // Attachments alone are a submission: a screenshot with no question is a
  // real thing to send.
  return (message.value.trim().length > 0 || attachments.value.length > 0)
    && hasAuth.value
    && hasWorkingDirectory.value
    && !currentModeMismatch.value;
});


const hasQueuedPrompts = computed(() => queuedPrompts.value.length > 0);

/**
 * Why the queue is sitting there.
 *
 * "Waiting to be sent" was true of both of the cases where nothing is
 * happening, and useless in the one that needs explaining. A queue held
 * because the user stopped a turn, or because one failed, will not move on its
 * own however long they wait — which looks exactly like the queue being broken
 * unless it says so and points at the button.
 */
const queueStatus = computed(() => {
  if (isLoading.value) return '· sent when this turn finishes';
  if (queueHeld.value) return '· paused — use Send now';
  return '· waiting to be sent';
});

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

/**
 * Images attached to the prompt being written.
 *
 * Stored the moment they are attached, so what is held here is a reference
 * and the bytes cross IPC once rather than on every keystroke-driven
 * re-render or on send. Cleared when the prompt goes.
 */
const attachments = ref<MessageImage[]>([]);
const fileInputRef = ref<HTMLInputElement | null>(null);
const attachError = ref<string | null>(null);
const isDraggingOver = ref(false);

/** Only what the API takes; anything else is refused with a reason. */
function isAcceptedImage(file: File | null): boolean {
  return !!file && (IMAGE_MEDIA_TYPES as readonly string[]).includes(file.type);
}

async function attachFiles(files: Iterable<File>): Promise<void> {
  const conversationId = conversationsStore.currentConversationId;
  if (!conversationId) {
    attachError.value = 'Open a conversation before attaching an image.';
    return;
  }

  attachError.value = null;
  for (const file of files) {
    if (!isAcceptedImage(file)) {
      attachError.value = `${file.name || 'That file'} is not a PNG, JPEG, GIF or WebP.`;
      continue;
    }
    try {
      const base64 = await fileToBase64(file);
      const stored = await window.electron.conversation.saveImage(conversationId, {
        base64,
        mediaType: file.type,
        ...(file.name ? { label: file.name } : {}),
      });
      if (!stored) {
        // The store refused it — oversized, or not decodable. Said plainly
        // rather than left as an attachment that would vanish on send.
        attachError.value = `${file.name || 'That image'} could not be attached (too large?).`;
        continue;
      }
      attachments.value = [...attachments.value, stored];
    } catch (err) {
      logger.error('Failed to attach an image', { err });
      attachError.value = 'Could not attach that image.';
    }
  }
}

/** The bytes, base64-encoded, without the data: prefix a FileReader adds. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

function removeAttachment(id: string): void {
  attachments.value = attachments.value.filter((image) => image.id !== id);
}

/**
 * Pasting a file.
 *
 * A paste carrying no files is an ordinary text paste and is left alone —
 * intercepting those would break the thing the composer is mostly for. A
 * paste that does carry files goes to `attachFiles`, which names any it
 * cannot use. Filtering them out here instead meant pasting, say, an SVG did
 * nothing at all and said nothing about why.
 */
function handlePaste(event: ClipboardEvent): void {
  const items = event.clipboardData?.files;
  // No files at all is an ordinary text paste, and not ours to touch.
  if (!items || items.length === 0) return;

  event.preventDefault();
  void attachFiles(items);
}

function handleDrop(event: DragEvent): void {
  isDraggingOver.value = false;
  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return;

  event.preventDefault();
  void attachFiles(files);
}

function handleFilePick(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (input.files) void attachFiles(input.files);
  // Cleared so picking the same file twice in a row still fires a change.
  input.value = '';
}

/**
 * Submit the prompt. With no turn running it is sent. During one the user
 * chooses, as with Stop: `send` puts it into the running turn, which Claude
 * reads at its next step; `queue` holds it for after the turn. Attachments go
 * either way — they are references to images already stored.
 */
function handleSubmit(during: 'send' | 'queue' = 'send'): void {
  if (!canSubmit.value) return;

  const prompt = message.value.trim();
  const images = attachments.value.length > 0 ? [...attachments.value] : undefined;
  if (!isLoading.value) emit('send', prompt, images);
  else if (during === 'send') emit('send-now', prompt, images);
  else emit('queue', prompt, images);
  attachments.value = [];
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
    handleSubmit(event.ctrlKey || event.metaKey ? 'queue' : 'send');
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

/**
 * The extra options on Stop.
 *
 * Stop on its own means "stop this turn" and leaves background agents and
 * workflows running, which is the behaviour worth having by default — a turn
 * is usually interrupted to redirect it, not to abandon the work it started.
 * Taking everything down is still wanted sometimes, so it is one click away
 * rather than the only thing on offer.
 *
 * The caret only appears when there is actually something else running, so the
 * common case stays a single button and the menu never offers a choice between
 * two identical outcomes.
 */
const stopMenuOpen = ref(false);
const stopMenuAt = ref({ x: 0, y: 0 });

const stopMenuItems = computed((): ContextMenuItem[] => [
  {
    label: 'Stop this turn only',
    onSelect: () => emit('abort'),
  },
  {
    label: `Stop this turn and ${runningBackgroundTasksList.value.length} background ${
      runningBackgroundTasksList.value.length === 1 ? 'task' : 'tasks'
    }`,
    onSelect: () => emit('abort-everything'),
  },
]);

function openStopMenu(event: MouseEvent): void {
  const button = event.currentTarget as HTMLElement;
  const box = button.getBoundingClientRect();
  // Opened above the button, as its caret points: anchored at the button's
  // top it used to open downward over the button itself.
  stopMenuAt.value = { x: box.left, y: box.top };
  stopMenuOpen.value = true;
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
    <!--
      Prompts sent into the running turn that Claude has not read yet. They
      join the discussion when it does, at its next step, so until then this
      is the only sign that Send did something.
    -->
    <div
      v-if="deliveringPrompts.length > 0"
      class="mb-3 rounded-lg border border-primary-200 dark:border-primary-800 bg-primary-50/50 dark:bg-primary-900/10"
      data-testid="delivering-prompts"
    >
      <div class="flex items-center gap-1.5 px-3 py-2 border-b border-primary-200 dark:border-primary-800 text-xs font-medium text-surface-600 dark:text-surface-300">
        <Icon
          name="send"
          size="xs"
        />
        {{ deliveringPrompts.length }} sent
        <span class="font-normal text-surface-400 dark:text-surface-500">
          · Claude reads {{ deliveringPrompts.length === 1 ? 'it' : 'them' }} at its next step
        </span>
      </div>
      <ul class="divide-y divide-primary-200 dark:divide-primary-800">
        <li
          v-for="prompt in deliveringPrompts"
          :key="prompt.uuid"
          class="flex items-start gap-2 px-3 py-2"
        >
          <span class="flex-1 min-w-0 text-xs text-surface-700 dark:text-surface-200 whitespace-pre-wrap break-words line-clamp-3">{{ prompt.content }}</span>
          <span
            v-if="prompt.tooLate"
            class="shrink-0 text-xs text-surface-400 dark:text-surface-500"
          >Claude already has it</span>
          <button
            v-else
            type="button"
            class="shrink-0 p-1 rounded text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 hover:bg-surface-200 dark:hover:bg-surface-700"
            title="Take this back before Claude reads it"
            @click="emit('take-back', prompt.uuid)"
          >
            <Icon
              name="close"
              size="xs"
            />
          </button>
        </li>
      </ul>
    </div>

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
            {{ queueStatus }}
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

          <!-- What is attached to the prompt being written. -->
          <div
            v-if="attachments.length > 0"
            class="flex flex-wrap gap-2 mb-2"
          >
            <span
              v-for="image in attachments"
              :key="image.id"
              class="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-md bg-surface-100 dark:bg-surface-700 text-xs text-surface-700 dark:text-surface-200"
            >
              <Icon
                name="image"
                size="xs"
              />
              <span class="max-w-[12rem] truncate">{{ image.label || 'image' }}</span>
              <button
                type="button"
                class="p-0.5 rounded hover:bg-surface-200 dark:hover:bg-surface-600"
                :aria-label="`Remove ${image.label || 'image'}`"
                @click="removeAttachment(image.id)"
              >
                <Icon
                  name="close"
                  size="xs"
                />
              </button>
            </span>
          </div>

          <p
            v-if="attachError"
            class="mb-2 text-xs text-red-500 dark:text-red-400"
          >
            {{ attachError }}
          </p>

          <textarea
            ref="inputRef"
            v-model="message"
            :placeholder="placeholder"
            :disabled="isDisabled"
            class="input-base resize-none min-h-[44px] max-h-[200px] pr-4"
            :class="[
              { 'opacity-60 cursor-not-allowed': isDisabled },
              isDraggingOver ? 'ring-2 ring-primary-400' : '',
            ]"
            rows="1"
            @keydown="handleKeydown"
            @input="handleInput"
            @paste="handlePaste"
            @drop="handleDrop"
            @dragover.prevent="isDraggingOver = true"
            @dragleave="isDraggingOver = false"
          />

          <input
            ref="fileInputRef"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            class="hidden"
            @change="handleFilePick"
          >
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
          <span v-else-if="isLoading">Enter sends it into this turn, Ctrl+Enter queues it for after, Shift+Enter for new line</span>
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
        <!-- Attach an image. The model can be shown pictures, so there has to
             be a way to hand it one that does not depend on knowing you can
             paste. -->
        <Button
          variant="secondary"
          size="md"
          :disabled="isDisabled"
          title="Attach an image (or paste one)"
          @click="fileInputRef?.click()"
        >
          <Icon
            name="image"
            size="sm"
          />
        </Button>

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
             available mid-turn was the one that kills the run.

             One split control, not two buttons with a gap: the caret is a
             second way to press the same thing, so it reads as part of it. -->
        <div
          v-if="isLoading"
          class="split-control"
        >
          <Button
            variant="danger"
            size="md"
            title="Stop this turn. Background tasks and agents keep running."
            @click="handleAbort"
          >
            <Icon
              name="close"
              size="sm"
              class="mr-1"
            />
            Stop
          </Button>

          <!-- Only when there is something a plain Stop would now leave
               running; otherwise the menu's two items mean the same thing. -->
          <Button
            v-if="hasRunningBackgroundTasks"
            variant="danger"
            size="md"
            class="px-2"
            title="More ways to stop"
            @click="openStopMenu"
          >
            <Icon
              name="chevron-up"
              size="sm"
            />
          </Button>
        </div>

        <!-- Background work outlives the turn, so the control for it has to as
             well. Stop deliberately spares running agents and tasks, which
             means that once the turn ends they are still going and this is the
             only place to end them — the alternative was opening each task's
             detail modal in turn, or nothing at all. -->
        <Button
          v-else-if="hasRunningBackgroundTasks"
          variant="danger"
          size="md"
          :title="`Stop the ${runningBackgroundTasksList.length} background ${
            runningBackgroundTasksList.length === 1 ? 'task' : 'tasks'
          } still running`"
          @click="emit('stop-tasks')"
        >
          <Icon
            name="stop"
            size="sm"
            class="mr-1"
          />
          Stop {{ runningBackgroundTasksList.length }}
          {{ runningBackgroundTasksList.length === 1 ? 'task' : 'tasks' }}
        </Button>

        <!-- During a turn, the same two choices Stop offers in reverse: step
             into the running turn, or leave it alone. Both labelled, one
             click each. -->
        <div
          v-if="isLoading"
          class="split-control"
        >
          <Button
            variant="primary"
            size="md"
            :disabled="!canSubmit"
            title="Send it into this turn: Claude reads it at its next step (Enter)"
            @click="handleSubmit('send')"
          >
            <Icon
              name="send"
              size="sm"
              class="mr-1"
            />
            Send
          </Button>
          <Button
            variant="primary"
            size="md"
            :disabled="!canSubmit"
            title="Queue it: sent when this turn finishes (Ctrl+Enter)"
            @click="handleSubmit('queue')"
          >
            <!-- `history` is the clock glyph; there is no separate clock
                 icon, and adding one would duplicate the same path. -->
            <Icon
              name="history"
              size="sm"
              class="mr-1"
            />
            Queue
          </Button>
        </div>
        <Button
          v-else
          variant="primary"
          size="md"
          :disabled="!canSubmit"
          title="Send this prompt"
          @click="handleSubmit()"
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

    <ContextMenu
      :open="stopMenuOpen"
      :x="stopMenuAt.x"
      :y="stopMenuAt.y"
      :items="stopMenuItems"
      above
      @close="stopMenuOpen = false"
    />
  </div>
</template>

<style scoped>
/*
 * One control split into a main action and a caret.
 *
 * Written as CSS rather than utility classes on the buttons: `btn` already
 * sets `border-radius`, so squaring off the inner corners with a utility would
 * mean relying on which of two equally specific rules the stylesheet happens
 * to emit last. A scoped selector carries the component's data attribute as
 * well as a child combinator, so it wins outright and the result does not
 * depend on utility ordering.
 *
 * The divider is an inset line rather than a gap: a gap made the caret read as
 * a separate button that happened to sit nearby.
 */
.split-control {
  display: inline-flex;
  align-items: center;
}

.split-control > :not(:last-child) {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}

.split-control > :not(:first-child) {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  /* Light enough to read as a seam in one surface, not an edge between two. */
  box-shadow: inset 1px 0 0 rgb(255 255 255 / 0.25);
}
</style>
