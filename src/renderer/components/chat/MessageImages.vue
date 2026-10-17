<script setup lang="ts">
/**
 * The images on a message.
 *
 * A message carries references, not bytes (see MessageImage), so the bytes
 * are fetched here — once per image, when the row is actually drawn. That is
 * the whole point of the split: the transcript can hold thousands of messages
 * and a handful of them can have megabyte screenshots attached without either
 * the saved file or the in-memory window paying for it.
 *
 * Bytes become a blob URL rather than a `data:` URI. A data URI of a
 * multi-megabyte image is a multi-megabyte string living in the DOM, re-parsed
 * on every render; a blob URL is a handle, and it is revoked when the row goes
 * away — which matters here, because this list is virtualised and rows are
 * mounted and unmounted constantly as the user scrolls.
 */
import { ref, watch, onUnmounted } from 'vue';

import type { MessageImage } from '@shared/types';

import { logger } from '../../utils/logger';

const props = defineProps<{
  conversationId: string;
  images: MessageImage[];
}>();

/** Blob URL per image id, and the failures, so a gap can be shown as one. */
const urls = ref<Map<string, string>>(new Map());
const failed = ref<Set<string>>(new Set());

function releaseAll(): void {
  for (const url of urls.value.values()) URL.revokeObjectURL(url);
  urls.value = new Map();
}

async function load(images: MessageImage[], conversationId: string): Promise<void> {
  for (const image of images) {
    if (urls.value.has(image.id) || failed.value.has(image.id)) continue;
    try {
      const bytes = await window.electron.conversation.readImage(
        conversationId, image.id, image.mediaType,
      );
      if (!bytes) {
        // The reference outlived the file. A gap in the transcript, shown as
        // one rather than as a broken image.
        failed.value.add(image.id);
        continue;
      }
      // Decoded here rather than handed to the DOM as a data: URI.
      const binary = atob(bytes.base64);
      const buffer = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) buffer[i] = binary.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([buffer], { type: bytes.mediaType }));
      urls.value.set(image.id, url);
      // The Map is replaced rather than mutated: Vue tracks the ref, and a
      // mutation in place would not redraw the row.
      urls.value = new Map(urls.value);
    } catch (err) {
      logger.error('Failed to load an image for display', { id: image.id, err });
      failed.value.add(image.id);
      failed.value = new Set(failed.value);
    }
  }
}

/**
 * Keyed on a STRING, not an array.
 *
 * A getter returning a fresh array is a fresh value every time Vue evaluates
 * it, so the watcher fired on every re-render — revoking the blob URLs and
 * fetching the bytes again. In a virtualised list, which re-renders rows
 * constantly, that is a flicker on every scroll and an IPC read per frame.
 * A string compares by value, so it fires only when the images really change.
 */
watch(
  () => `${props.conversationId}|${props.images.map((i) => i.id).join(',')}`,
  () => {
    releaseAll();
    failed.value = new Set();
    void load(props.images, props.conversationId);
  },
  { immediate: true },
);

onUnmounted(releaseAll);

function sizeLabel(image: MessageImage): string {
  const kb = image.byteSize / 1024;
  const size = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;
  const dims = image.width && image.height ? `${image.width}×${image.height}, ` : '';
  return `${dims}${size}`;
}
</script>

<template>
  <div
    v-if="images.length > 0"
    class="flex flex-wrap gap-2 mt-2"
  >
    <figure
      v-for="image in images"
      :key="image.id"
      class="max-w-full"
    >
      <img
        v-if="urls.get(image.id)"
        :src="urls.get(image.id)"
        :alt="image.label || 'Attached image'"
        class="max-w-full max-h-96 rounded-lg border border-surface-200 dark:border-surface-700"
        :width="image.width"
        :height="image.height"
      >
      <div
        v-else-if="failed.has(image.id)"
        class="px-3 py-2 rounded-lg border border-dashed border-surface-300 dark:border-surface-600 text-xs text-surface-500 dark:text-surface-400"
      >
        {{ image.label || 'Image' }} — no longer stored
      </div>
      <div
        v-else
        class="px-3 py-2 rounded-lg border border-surface-200 dark:border-surface-700 text-xs text-surface-500 dark:text-surface-400"
      >
        Loading image…
      </div>
      <figcaption
        v-if="urls.get(image.id)"
        class="mt-1 text-xs text-surface-500 dark:text-surface-400"
      >
        {{ image.label ? image.label + ' · ' : '' }}{{ sizeLabel(image) }}
      </figcaption>
    </figure>
  </div>
</template>
