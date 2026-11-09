<script setup lang="ts">
/**
 * "Show changes" for a file of the file panel.
 *
 * In a git repository: what is not committed yet, or else the file's last
 * commit, as git shows them. Outside one there is nothing to ask git, so it
 * is Claude's own edits to the file in the discussion's last turn, read off
 * its Edit/Write calls.
 */

import { computed, ref, watch } from 'vue';

import { claudeEditsPatch, type FileWritingCall } from '@shared/file-modifications';
import type { FileChanges } from '@shared/types';

import { useChatStore } from '../../stores/chat';
import Modal from '../shared/Modal.vue';
import Spinner from '../shared/Spinner.vue';
import { logger } from '../../utils/logger';

interface Props {
  open: boolean;
  /** The file, and the working directory it belongs to. */
  filePath: string | null;
  workingDirectory: string | null;
}

const props = defineProps<Props>();
const emit = defineEmits<{ (e: 'close'): void }>();

const chatStore = useChatStore();

/** What is shown: where the changes come from, and the patch, if any. */
interface Shown {
  source: string;
  detail?: string;
  patch: string | null;
  empty: string;
}

const shown = ref<Shown | null>(null);
const loading = ref(false);
const failure = ref<string | null>(null);

const fileName = computed(() => props.filePath?.split(/[\\/]/).pop() ?? '');

/** The calls Claude made in the discussion's last turn, the one the file markers are about. */
function lastTurnCalls(): FileWritingCall[] {
  const messages = chatStore.messages;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'user' && !message.toolUse && !message.backgroundTask) break;
    start = i;
  }
  return messages.slice(start).flatMap((message) => (message.toolUse ? [message.toolUse] : []));
}

function describe(changes: FileChanges, filePath: string): Shown {
  switch (changes.source) {
    case 'uncommitted':
      return { source: 'Not committed yet', patch: changes.patch, empty: '' };
    case 'last-commit': {
      const { shortHash, subject, author, date } = changes.commit;
      return {
        source: `Last commit ${shortHash}`,
        detail: `${subject} — ${author}, ${new Date(date).toLocaleString()}`,
        patch: changes.patch,
        empty: '',
      };
    }
    case 'none':
      return { source: 'No changes', patch: null, empty: 'Nothing uncommitted, and no commit has touched this file.' };
    case 'not-a-repository':
      return {
        source: "Claude's edits in the last turn",
        detail: 'Not a git repository',
        patch: claudeEditsPatch(lastTurnCalls(), filePath),
        // A file marked by the folder watcher only — changed by a command
        // Claude ran — has no edit to show, and nothing kept its old version.
        empty: "Claude made no edit to this file in the last turn. A change made by a command it ran can't be shown outside a git repository.",
      };
  }
}

async function load(filePath: string, workingDirectory: string): Promise<void> {
  loading.value = true;
  failure.value = null;
  shown.value = null;
  try {
    const changes = await window.electron.git.fileChanges(workingDirectory, filePath);
    if (props.filePath !== filePath) return;
    shown.value = describe(changes, filePath);
  } catch (error) {
    logger.error('Failed to get the changes of a file', error);
    failure.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (props.filePath === filePath) loading.value = false;
  }
}

watch(
  () => [props.open, props.filePath, props.workingDirectory] as const,
  ([open, filePath, workingDirectory]) => {
    if (open && filePath && workingDirectory) void load(filePath, workingDirectory);
  },
  { immediate: true },
);

/** A patch line's look: added, removed, a hunk header, or git's file headers. */
function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
    return 'text-surface-500 dark:text-surface-400';
  }
  if (line.startsWith('+')) return 'bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-300';
  if (line.startsWith('-')) return 'bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300';
  if (line.startsWith('@@')) return 'text-blue-600 dark:text-blue-400';
  return 'text-surface-700 dark:text-surface-300';
}

const lines = computed(() => shown.value?.patch?.split('\n') ?? []);
</script>

<template>
  <Modal
    :open="open"
    :title="`Changes: ${fileName}`"
    size="3xl"
    resize-key="file-changes"
    @close="emit('close')"
  >
    <div
      v-if="loading"
      class="flex items-center gap-2 text-sm text-surface-500"
    >
      <Spinner size="sm" /> Reading the changes…
    </div>
    <p
      v-else-if="failure"
      class="file-changes-failure text-sm text-red-600 dark:text-red-400"
    >
      {{ failure }}
    </p>
    <div
      v-else-if="shown"
      class="space-y-3"
    >
      <div class="text-sm">
        <span class="file-changes-source font-medium text-surface-900 dark:text-surface-100">{{ shown.source }}</span>
        <span
          v-if="shown.detail"
          class="file-changes-detail text-surface-500 dark:text-surface-400"
        > · {{ shown.detail }}</span>
      </div>
      <p
        v-if="!shown.patch"
        class="file-changes-empty text-sm text-surface-500 dark:text-surface-400"
      >
        {{ shown.empty }}
      </p>
      <pre
        v-else
        class="file-changes-patch text-xs font-mono rounded border border-surface-200 dark:border-surface-700 overflow-auto"
      ><div
        v-for="(line, i) in lines"
        :key="i"
        class="px-2 whitespace-pre"
        :class="lineClass(line)"
      >{{ line || ' ' }}</div></pre>
    </div>
  </Modal>
</template>
