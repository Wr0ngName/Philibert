<script setup lang="ts">
/**
 * The working folder, atop the files panel: the path is what changes it, and
 * the gear beside it opens the project's own settings — not there for a
 * folder whose discussions are all archived, which Settings does not list.
 */

import { computed } from 'vue';
import { storeToRefs } from 'pinia';

import { useConversationsStore } from '../../stores/conversations';
import { useFilesStore } from '../../stores/files';
import { useMcpStore } from '../../stores/mcp';
import { useUiStore } from '../../stores/ui';
import Button from '../shared/Button.vue';
import Icon from '../shared/Icon.vue';

const filesStore = useFilesStore();
const conversationsStore = useConversationsStore();
const uiStore = useUiStore();
const { currentProjectListed } = storeToRefs(useMcpStore());
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
      <button
        type="button"
        class="working-directory-change flex-1 min-w-0 flex items-center gap-2 px-3 py-2 bg-surface-100 dark:bg-surface-700 rounded-lg hover:bg-surface-200 dark:hover:bg-surface-600 transition-colors disabled:opacity-60"
        :title="workingDirectory ? `${workingDirectory}\nClick to change folder` : 'Choose a folder'"
        :aria-label="workingDirectory ? `Change folder: ${workingDirectory}` : 'Choose a folder'"
        :disabled="isLoading"
        @click="selectDirectory"
      >
        <Icon
          :name="isLoading ? 'loading' : 'folder'"
          size="sm"
          :class="isLoading ? 'text-surface-400 shrink-0 animate-spin' : 'text-surface-400 shrink-0'"
        />
        <span
          :class="[
            'text-sm truncate',
            hasWorkingDirectory
              ? 'text-surface-700 dark:text-surface-300'
              : 'text-surface-400 dark:text-surface-500 italic',
          ]"
        >
          {{ displayPath }}
        </span>
      </button>

      <button
        v-if="currentProjectListed"
        type="button"
        class="working-directory-settings btn-icon shrink-0"
        title="Project settings"
        aria-label="Project settings"
        @click="uiStore.openProjectSettings()"
      >
        <Icon
          name="settings"
          size="sm"
        />
      </button>
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
