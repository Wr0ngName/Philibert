<script setup lang="ts">
/**
 * Markdown viewer modal — renders a .md/.markdown/.mdx file inline instead
 * of shelling out to the OS default handler. Uses the same marked+DOMPurify
 * pipeline the chat uses (renderMarkdown), so styling and safety are
 * consistent across the app.
 *
 * File content is fetched on open (or whenever the path changes while open),
 * and cleared when closed so a subsequent open re-reads from disk instead of
 * showing a stale snapshot.
 */

import { computed, ref, watch } from 'vue';

import { renderMarkdown } from '../../utils/markdown';
import { logger } from '../../utils/logger';
import Modal from '../shared/Modal.vue';
import Spinner from '../shared/Spinner.vue';

interface Props {
  open: boolean;
  filePath: string | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const content = ref<string | null>(null);
const isLoading = ref(false);
const loadError = ref<string | null>(null);

const displayName = computed(() => {
  if (!props.filePath) return '';
  return props.filePath.split(/[/\\]/).pop() ?? props.filePath;
});

const renderedHtml = computed(() => {
  if (content.value === null) return '';
  return renderMarkdown(content.value);
});

async function loadContent(path: string): Promise<void> {
  isLoading.value = true;
  loadError.value = null;
  content.value = null;
  try {
    const text = await window.electron.files.read(path);
    content.value = text ?? '';
  } catch (err) {
    logger.error('Failed to read markdown file for viewer', { path, err });
    loadError.value = err instanceof Error ? err.message : 'Failed to read file';
  } finally {
    isLoading.value = false;
  }
}

watch(
  () => [props.open, props.filePath] as const,
  ([open, path]) => {
    if (open && path) {
      loadContent(path);
    } else if (!open) {
      content.value = null;
      loadError.value = null;
    }
  },
  { immediate: true },
);
</script>

<template>
  <Modal
    :open="open"
    :title="displayName"
    size="3xl"
    :aria-description="`Rendered preview of ${displayName}`"
    @close="emit('close')"
  >
    <div
      v-if="isLoading"
      class="flex items-center justify-center py-12"
    >
      <Spinner size="md" />
    </div>

    <div
      v-else-if="loadError"
      class="py-6 text-sm text-red-600 dark:text-red-400"
    >
      {{ loadError }}
    </div>

    <div
      v-else
      class="prose prose-sm dark:prose-invert max-w-full text-surface-800 dark:text-surface-200"
      v-html="renderedHtml"
    />
  </Modal>
</template>
