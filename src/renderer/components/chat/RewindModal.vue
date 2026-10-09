<script setup lang="ts">
/**
 * Rewind dialog — restore files and/or the conversation to an earlier turn.
 *
 * The CLI draws an interactive picker for `/rewind`, which cannot render in a
 * chat window, so this is the same choice as a dialog: pick a turn, pick what
 * to restore, see a dry-run preview, then confirm.
 *
 * The preview is not a nicety. Restoring files overwrites the working tree and
 * nothing in this app can undo that, so the file list and line counts are shown
 * before anything is written. The preview is re-run whenever the target or the
 * scope changes, because a stale preview is worse than none.
 *
 * Only turns Claude Code acknowledged can be targeted: the rewind point is the
 * transcript id it echoed back, and a turn without one is not a place the CLI
 * can return to. Those are listed as disabled rather than hidden, so a short
 * list does not look like a bug.
 */

import { computed, ref, watch } from 'vue';

import type { RewindPreview, RewindScope } from '@shared/types';

import { useChatStore } from '../../stores/chat';
import { logger } from '../../utils/logger';
import Modal from '../shared/Modal.vue';
import Spinner from '../shared/Spinner.vue';

interface Props {
  open: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const chatStore = useChatStore();

/** Turn the rewind targets, by transcript id. */
const selectedUuid = ref<string | null>(null);
const scope = ref<RewindScope>('both');
const preview = ref<RewindPreview | null>(null);
const isPreviewing = ref(false);
const isApplying = ref(false);
const applyError = ref<string | null>(null);

// Guards against a slow preview landing after the selection moved on.
let previewGeneration = 0;

/** User turns, newest first — the order someone looking to undo thinks in. */
const userTurns = computed(() =>
  chatStore.messages
    .filter((message) => message.role === 'user')
    .map((message) => ({
      id: message.id,
      uuid: message.turnUuid ?? null,
      /** Enough of the prompt to recognise it, on one line. */
      label: message.content.replace(/\s+/g, ' ').trim().slice(0, 120) || '(empty message)',
      timestamp: message.timestamp,
    }))
    .reverse(),
);

const rewindableTurns = computed(() => userTurns.value.filter((turn) => turn.uuid !== null));

/** Whether restoring files is part of what was asked for. */
const touchesFiles = computed(() => scope.value === 'code' || scope.value === 'both');

const canApply = computed(() => {
  if (!selectedUuid.value || isApplying.value || isPreviewing.value) return false;
  // A conversation-only rewind needs no checkpoint, so a preview that cannot
  // restore files does not block it.
  if (!touchesFiles.value) return true;
  return preview.value?.canRewind === true;
});

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function runPreview(): Promise<void> {
  const uuid = selectedUuid.value;
  const conversationId = chatStore.currentConversationId;
  if (!uuid || !conversationId || !touchesFiles.value) {
    preview.value = null;
    return;
  }

  const generation = ++previewGeneration;
  isPreviewing.value = true;
  applyError.value = null;
  try {
    const result = await window.electron.claude.previewRewind(conversationId, uuid);
    if (generation !== previewGeneration) return;
    preview.value = result;
  } catch (err) {
    if (generation !== previewGeneration) return;
    logger.error('Rewind preview failed', err);
    preview.value = {
      canRewind: false,
      error: err instanceof Error ? err.message : 'Could not read the checkpoint.',
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    };
  } finally {
    if (generation === previewGeneration) isPreviewing.value = false;
  }
}

async function apply(): Promise<void> {
  const uuid = selectedUuid.value;
  const conversationId = chatStore.currentConversationId;
  if (!uuid || !conversationId) return;

  isApplying.value = true;
  applyError.value = null;
  try {
    const outcome = await window.electron.claude.applyRewind(conversationId, uuid, scope.value);
    if (!outcome.ok) {
      applyError.value = outcome.error ?? 'The rewind was refused.';
      return;
    }

    // Report what happened in the transcript rather than only closing: a
    // restore that writes files silently is indistinguishable from one that
    // did nothing.
    const parts: string[] = ['## Rewound\n'];
    if (outcome.filesChanged.length > 0) {
      parts.push(
        `Restored ${outcome.filesChanged.length} ` +
          `file${outcome.filesChanged.length === 1 ? '' : 's'} ` +
          `(+${outcome.insertions} / -${outcome.deletions}):`,
        '',
        ...outcome.filesChanged.map((file) => `- \`${file}\``),
        '',
      );
    } else if (touchesFiles.value) {
      parts.push('No file differed from the checkpoint, so nothing was written.\n');
    }

    if (outcome.skippedLinks) {
      parts.push(
        `⚠️ ${outcome.skippedLinks} tracked ` +
          `file${outcome.skippedLinks === 1 ? ' was' : 's were'} left alone because the path ` +
          'is a symlink or hard link, its parent no longer resolves where it did, or its ' +
          'backup could not be read safely. The restore was partial.\n',
      );
    }

    if (outcome.conversationRewound) {
      parts.push(
        'The conversation is rewound to that turn — your next message continues from there, ' +
          'and the turns after it are gone.\n',
      );
    }

    // Truncate before reporting, not after: truncation drops everything from
    // the target turn onward, which would take this summary with it.
    if (outcome.conversationRewound) {
      chatStore.truncateAfterUserTurn(conversationId, uuid);
    }

    chatStore.addAssistantMessage(parts.join('\n'));

    emit('close');
  } catch (err) {
    logger.error('Rewind failed', err);
    applyError.value = err instanceof Error ? err.message : 'The rewind failed.';
  } finally {
    isApplying.value = false;
  }
}

// Default to the most recent rewindable turn when the dialog opens, and reset
// when it closes so the next open does not show a stale preview.
watch(
  () => props.open,
  (open) => {
    if (open) {
      selectedUuid.value = rewindableTurns.value[0]?.uuid ?? null;
      scope.value = 'both';
      applyError.value = null;
    } else {
      previewGeneration += 1;
      preview.value = null;
      selectedUuid.value = null;
      isPreviewing.value = false;
    }
  },
  { immediate: true },
);

watch([selectedUuid, scope], () => {
  void runPreview();
});
</script>

<template>
  <Modal
    :open="open"
    title="Rewind"
    size="2xl"
    aria-description="Restore files or the conversation to an earlier turn"
    @close="emit('close')"
  >
    <div
      v-if="rewindableTurns.length === 0"
      class="py-4 text-sm text-surface-600 dark:text-surface-300"
    >
      <p class="mb-2">
        There is nothing to rewind to yet.
      </p>
      <p>
        A turn can be rewound once Claude Code has acknowledged it, and checkpoints last as
        long as the session. Turns from a conversation that has since been reopened cannot be
        restored.
      </p>
    </div>

    <div
      v-else
      class="space-y-5"
    >
      <!-- Target turn -->
      <fieldset>
        <legend class="text-sm font-semibold text-surface-800 dark:text-surface-200 mb-2">
          Rewind to
        </legend>
        <div
          class="max-h-52 overflow-y-auto rounded-lg border border-surface-200 dark:border-surface-700 divide-y divide-surface-100 dark:divide-surface-700"
        >
          <label
            v-for="turn in userTurns"
            :key="turn.id"
            :class="[
              'flex items-start gap-3 px-3 py-2',
              turn.uuid
                ? 'cursor-pointer hover:bg-surface-50 dark:hover:bg-surface-700/50'
                : 'opacity-50 cursor-not-allowed',
            ]"
          >
            <input
              v-model="selectedUuid"
              type="radio"
              :value="turn.uuid"
              :disabled="!turn.uuid"
              name="rewind-target"
              class="mt-1 shrink-0"
            >
            <span class="min-w-0 flex-1">
              <span class="block text-sm text-surface-800 dark:text-surface-200 truncate">
                {{ turn.label }}
              </span>
              <span class="block text-xs text-surface-500 dark:text-surface-400">
                {{ formatTime(turn.timestamp) }}
                <template v-if="!turn.uuid"> · no checkpoint</template>
              </span>
            </span>
          </label>
        </div>
      </fieldset>

      <!-- Scope -->
      <fieldset>
        <legend class="text-sm font-semibold text-surface-800 dark:text-surface-200 mb-2">
          Restore
        </legend>
        <div class="space-y-2">
          <label class="flex items-start gap-3 cursor-pointer">
            <input
              v-model="scope"
              type="radio"
              value="code"
              name="rewind-scope"
              class="mt-1"
            >
            <span class="text-sm">
              <span class="text-surface-800 dark:text-surface-200">Code only</span>
              <span class="block text-xs text-surface-500 dark:text-surface-400">
                Files go back; the conversation still describes the edits.
              </span>
            </span>
          </label>
          <label class="flex items-start gap-3 cursor-pointer">
            <input
              v-model="scope"
              type="radio"
              value="conversation"
              name="rewind-scope"
              class="mt-1"
            >
            <span class="text-sm">
              <span class="text-surface-800 dark:text-surface-200">Conversation only</span>
              <span class="block text-xs text-surface-500 dark:text-surface-400">
                Later turns are dropped; your files keep every change they made.
              </span>
            </span>
          </label>
          <label class="flex items-start gap-3 cursor-pointer">
            <input
              v-model="scope"
              type="radio"
              value="both"
              name="rewind-scope"
              class="mt-1"
            >
            <span class="text-sm">
              <span class="text-surface-800 dark:text-surface-200">Both</span>
              <span class="block text-xs text-surface-500 dark:text-surface-400">
                Files and conversation both return to that turn.
              </span>
            </span>
          </label>
        </div>
      </fieldset>

      <!-- Preview -->
      <div
        v-if="touchesFiles"
        class="rounded-lg bg-surface-50 dark:bg-surface-700/40 px-3 py-3 text-sm"
      >
        <div
          v-if="isPreviewing"
          class="flex items-center gap-2 text-surface-600 dark:text-surface-300"
        >
          <Spinner size="sm" />
          <span>Checking what would change…</span>
        </div>

        <div
          v-else-if="!preview"
          class="text-surface-500 dark:text-surface-400"
        >
          Select a turn to see what would be restored.
        </div>

        <div
          v-else-if="!preview.canRewind"
          class="text-red-600 dark:text-red-400"
        >
          {{ preview.error || 'Files cannot be restored to this turn.' }}
        </div>

        <div v-else>
          <p class="text-surface-800 dark:text-surface-200 mb-2">
            {{ preview.filesChanged.length }}
            file{{ preview.filesChanged.length === 1 ? '' : 's' }} would change
            <span class="text-surface-500 dark:text-surface-400">
              (+{{ preview.insertions }} / -{{ preview.deletions }})
            </span>
          </p>
          <ul
            v-if="preview.filesChanged.length > 0"
            class="max-h-32 overflow-y-auto font-mono text-xs text-surface-600 dark:text-surface-300 space-y-0.5"
          >
            <li
              v-for="file in preview.filesChanged"
              :key="file"
              class="truncate"
            >
              {{ file }}
            </li>
          </ul>
          <p
            v-else
            class="text-xs text-surface-500 dark:text-surface-400"
          >
            Nothing differs from the checkpoint, so no file would be written.
          </p>
        </div>
      </div>

      <p
        v-if="applyError"
        class="text-sm text-red-600 dark:text-red-400"
        role="alert"
      >
        {{ applyError }}
      </p>

      <p class="text-xs text-surface-500 dark:text-surface-400">
        Restoring files overwrites them on disk and cannot be undone from here.
      </p>
    </div>

    <template #footer>
      <button
        type="button"
        class="px-4 py-2 text-sm rounded-lg text-surface-700 dark:text-surface-200 hover:bg-surface-100 dark:hover:bg-surface-700"
        @click="emit('close')"
      >
        Cancel
      </button>
      <button
        v-if="rewindableTurns.length > 0"
        type="button"
        :disabled="!canApply"
        class="px-4 py-2 text-sm rounded-lg bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
        @click="apply"
      >
        {{ isApplying ? 'Rewinding…' : 'Rewind' }}
      </button>
    </template>
  </Modal>
</template>
