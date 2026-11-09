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
import type { FileChanges, FileChangeView, HexRow } from '@shared/types';

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

/** What is shown: where the changes come from, and the change, if any. */
interface Shown {
  source: string;
  detail?: string;
  view: FileChangeView | null;
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
      return { source: 'Not committed yet', view: changes.view, empty: '' };
    case 'last-commit': {
      const { shortHash, subject, author, date } = changes.commit;
      return {
        source: `Last commit ${shortHash}`,
        detail: `${subject} — ${author}, ${new Date(date).toLocaleString()}`,
        view: changes.view,
        empty: '',
      };
    }
    case 'none':
      return { source: 'No changes', view: null, empty: 'Nothing uncommitted, and no commit has touched this file.' };
    case 'not-a-repository': {
      const patch = claudeEditsPatch(lastTurnCalls(), filePath);
      return {
        source: "Claude's edits in the last turn",
        detail: 'Not a git repository',
        view: patch ? { kind: 'text', patch } : null,
        // A file marked by the folder watcher only — changed by a command
        // Claude ran — has no edit to show, and nothing kept its old version.
        empty: "Claude made no edit to this file in the last turn. A change made by a command it ran can't be shown outside a git repository.",
      };
    }
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

const view = computed(() => shown.value?.view ?? null);
const lines = computed(() => (view.value?.kind === 'text' ? view.value.patch.split('\n') : []));

const numbers = new Intl.NumberFormat();

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${numbers.format(bytes)} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What a cut patch is the start of: its lines changed, else its file's size. */
const truncation = computed(() => {
  const cut = view.value?.kind === 'text' ? view.value.truncated : undefined;
  if (!cut) return null;
  const whole = cut.added !== null && cut.removed !== null
    ? `a change of +${numbers.format(cut.added)} −${numbers.format(cut.removed)} lines`
    : cut.bytes !== null ? `a ${formatBytes(cut.bytes)} file` : 'a larger change';
  return `Showing the first ${numbers.format(cut.shownLines)} lines of ${whole}.`;
});

/** One side of a picture comparison: the picture, or why there is none. */
function picture(base64: string | null, bytes: number | null, mediaType: string): { src: string | null; note: string } {
  if (bytes === null) return { src: null, note: 'Did not exist' };
  if (base64 === null) return { src: null, note: `Too large to show (${formatBytes(bytes)})` };
  return { src: `data:${mediaType};base64,${base64}`, note: formatBytes(bytes) };
}

/** A row's bytes as printable characters, the rest as dots, as hex editors show them. */
function printable(bytes: string[] | null): string {
  return bytes ? bytes.map((hex) => { const code = parseInt(hex, 16); return code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : '.'; }).join('') : '';
}

/** Whether a byte differs from the one at the same place on the other side. */
function byteDiffers(bytes: string[] | null, other: string[] | null, i: number): boolean {
  return !other || other[i] !== bytes?.[i];
}

/** The lines a hex row shows: once when the same on both sides, else before (-) then after (+). */
function hexLines(row: HexRow): Array<{
  mark: ' ' | '-' | '+';
  side: string;
  bytes: string[];
  other: string[] | null;
  lineClass: string;
  byteClass: string;
}> {
  const same = !!row.before && !!row.after && row.before.join() === row.after.join();
  if (same) return [{ mark: ' ', side: 'both', bytes: row.before!, other: row.after, lineClass: '', byteClass: '' }];
  return [
    ...(row.before ? [{
      mark: '-' as const, side: 'before', bytes: row.before, other: row.after,
      lineClass: 'bg-red-50/60 dark:bg-red-900/20', byteClass: 'bg-red-200 text-red-900 dark:bg-red-800/60 dark:text-red-100',
    }] : []),
    ...(row.after ? [{
      mark: '+' as const, side: 'after', bytes: row.after, other: row.before,
      lineClass: 'bg-green-50/60 dark:bg-green-900/20', byteClass: 'bg-green-200 text-green-900 dark:bg-green-800/60 dark:text-green-100',
    }] : []),
  ];
}

function offsetOf(offset: number): string {
  return offset.toString(16).padStart(8, '0');
}

function sizeOf(bytes: number | null): string {
  return bytes === null ? 'none' : formatBytes(bytes);
}
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
        v-if="!view"
        class="file-changes-empty text-sm text-surface-500 dark:text-surface-400"
      >
        {{ shown.empty }}
      </p>

      <!-- Text: the patch, cut to a size -->
      <template v-else-if="view.kind === 'text'">
        <p
          v-if="truncation"
          class="file-changes-truncated text-xs text-amber-700 dark:text-amber-400"
        >
          {{ truncation }}
        </p>
        <pre
          class="file-changes-patch text-xs font-mono rounded border border-surface-200 dark:border-surface-700 overflow-auto"
        ><div
          v-for="(line, i) in lines"
          :key="i"
          class="px-2 whitespace-pre"
          :class="lineClass(line)"
        >{{ line || ' ' }}</div></pre>
      </template>

      <!-- A picture: before and after -->
      <div
        v-else-if="view.kind === 'image'"
        class="file-changes-images grid grid-cols-2 gap-3"
      >
        <figure
          v-for="side in [
            { label: 'Before', ...picture(view.before, view.beforeBytes, view.mediaType) },
            { label: 'After', ...picture(view.after, view.afterBytes, view.mediaType) },
          ]"
          :key="side.label"
          class="file-changes-image flex flex-col gap-1 min-w-0"
        >
          <figcaption class="text-xs text-surface-500 dark:text-surface-400">
            {{ side.label }} · {{ side.note }}
          </figcaption>
          <div class="flex items-center justify-center rounded border border-surface-200 dark:border-surface-700 bg-[repeating-conic-gradient(#e5e7eb_0_25%,transparent_0_50%)] bg-[length:16px_16px] min-h-24 p-2">
            <img
              v-if="side.src"
              :src="side.src"
              :alt="`${fileName}, ${side.label.toLowerCase()}`"
              class="max-w-full max-h-[60vh] object-contain"
            >
          </div>
        </figure>
      </div>

      <!-- Other bytes: the rows that differ, side by side -->
      <template v-else>
        <p class="file-changes-binary text-xs text-surface-500 dark:text-surface-400">
          Binary file: {{ sizeOf(view.beforeBytes) }} → {{ sizeOf(view.afterBytes) }}.
          <span v-if="view.truncated && view.rows.length > 0"> Only the first differences are shown.</span>
        </p>
        <!-- Nothing differs in what was compared: the change is past the
             part read, or there is none. -->
        <p
          v-if="view.rows.length === 0"
          class="file-changes-hex-none text-sm text-surface-500 dark:text-surface-400"
        >
          {{ view.truncated ? 'The start of the file is identical; the difference is further in than is compared.' : 'No byte differs.' }}
        </p>
        <div
          v-else
          class="file-changes-hex text-xs font-mono rounded border border-surface-200 dark:border-surface-700 overflow-auto"
        >
          <template
            v-for="(row, i) in view.rows"
            :key="i"
          >
            <div
              v-if="'skipped' in row"
              class="hex-skipped px-2 py-0.5 text-surface-400 italic"
            >
              … {{ numbers.format(row.skipped) }} identical rows
            </div>
            <!-- Like the patch: a row the same on both sides once, a row
                 that differs as its before (-) above its after (+). Side by
                 side it needed 140 columns, more than the window has. -->
            <div
              v-else
              class="hex-row"
            >
              <div
                v-for="(line, l) in hexLines(row)"
                :key="line.mark"
                class="hex-line flex gap-[2ch] px-2 whitespace-pre"
                :class="line.lineClass"
                :data-side="line.side"
              >
                <!-- The offset on the row's first line only. -->
                <span class="text-surface-400 w-[8ch]">{{ l === 0 ? offsetOf(row.offset) : '' }}</span>
                <span class="w-[1ch]">{{ line.mark }}</span>
                <span class="hex-bytes inline-flex gap-[1ch] w-[47ch]"><span
                  v-for="(byte, b) in line.bytes"
                  :key="b"
                  :class="line.mark !== ' ' && byteDiffers(line.bytes, line.other, b) ? line.byteClass : ''"
                >{{ byte }}</span></span>
                <span class="hex-text w-[16ch] text-surface-500">{{ printable(line.bytes) }}</span>
              </div>
            </div>
          </template>
        </div>
      </template>
    </div>
  </Modal>
</template>
