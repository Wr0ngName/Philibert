<script setup lang="ts">
/**
 * Working directory selector component
 */

import { computed } from 'vue';
import { storeToRefs } from 'pinia';

import { useFilesStore } from '../../stores/files';
import Button from '../shared/Button.vue';
import Icon from '../shared/Icon.vue';

const filesStore = useFilesStore();
const { workingDirectory, hasWorkingDirectory, isLoading } = storeToRefs(filesStore);

const displayPath = computed(() => {
  if (!workingDirectory.value) {
    return 'No directory selected';
  }
  // Show last 2 path segments for readability
  const parts = workingDirectory.value.split(/[/\\]/);
  if (parts.length > 2) {
    return '.../' + parts.slice(-2).join('/');
  }
  return workingDirectory.value;
});

async function selectDirectory() {
  await filesStore.selectDirectory();
}
</script>

<template>
  <div class="px-3 py-3 border-b border-surface-200 dark:border-surface-700">
    <div class="flex items-center gap-2">
      <div
        class="flex-1 flex items-center gap-2 px-3 py-2 bg-surface-100 dark:bg-surface-700 rounded-lg cursor-pointer hover:bg-surface-200 dark:hover:bg-surface-600 transition-colors"
        @click="selectDirectory"
      >
        <Icon
          name="folder"
          size="sm"
          class="text-surface-400 shrink-0"
        />
        <span
          :class="[
            'text-sm truncate',
            hasWorkingDirectory
              ? 'text-surface-700 dark:text-surface-300'
              : 'text-surface-400 dark:text-surface-500 italic',
          ]"
          :title="workingDirectory"
        >
          {{ displayPath }}
        </span>
      </div>

      <Button
        variant="secondary"
        size="sm"
        :loading="isLoading"
        @click="selectDirectory"
      >
        <Icon
          name="upload"
          size="sm"
        />
      </Button>
    </div>
  </div>
</template>
