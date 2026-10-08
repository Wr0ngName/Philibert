<script setup lang="ts">
/**
 * Working directory selector component
 */

import { computed } from 'vue';
import { storeToRefs } from 'pinia';

import { useConversationsStore } from '../../stores/conversations';
import { useFilesStore } from '../../stores/files';
import Button from '../shared/Button.vue';
import Icon from '../shared/Icon.vue';

const filesStore = useFilesStore();
const conversationsStore = useConversationsStore();
const { workingDirectory, hasWorkingDirectory, isLoading } = storeToRefs(filesStore);
const { currentConversationId } = storeToRefs(conversationsStore);

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

/**
 * The directory the current discussion is actually running in, when that is
 * not the one selected above.
 *
 * A conversation is pinned to the directory its session was created in: the
 * CLI keys session files by a CWD-derived path, so resuming under a different
 * directory would not find them. Picking another directory mid-discussion
 * therefore cannot move it — and the selector changing while execution did
 * not is what made this look like it had applied.
 */
const pinnedDirectory = computed<string | null>(() => {
  const conversationId = currentConversationId.value;
  if (!conversationId) return null;
  // No session yet means nothing is pinned — the change does apply.
  if (!conversationsStore.currentConversationHasSession()) return null;

  const pinned = conversationsStore.getConversationWorkingDirectory(conversationId);
  if (!pinned || pinned === workingDirectory.value) return null;
  return pinned;
});

/** Last two segments of a path, matching how the selector abbreviates. */
function abbreviate(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : path;
}

function startConversationHere(): void {
  conversationsStore.createNewConversation();
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

    <!-- Say so when the selection no longer matches where this discussion
         runs, instead of letting the changed selector imply it moved. -->
    <div
      v-if="pinnedDirectory"
      class="mt-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800"
    >
      <div class="flex items-start gap-2">
        <Icon
          name="warning"
          size="xs"
          class="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5"
        />
        <div class="min-w-0">
          <div class="text-xs text-amber-800 dark:text-amber-200">
            This discussion keeps running in
            <span
              class="font-mono"
              :title="pinnedDirectory"
            >{{ abbreviate(pinnedDirectory) }}</span>.
            Its session is tied to that folder, so it cannot be moved without
            losing the conversation's context.
          </div>
          <Button
            variant="secondary"
            size="sm"
            class="mt-2"
            @click="startConversationHere"
          >
            <Icon
              name="plus"
              size="xs"
              class="mr-1"
            />
            New discussion here
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
