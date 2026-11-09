<script setup lang="ts">
/**
 * File tree component - displays project structure
 */

import { computed, onMounted, onUnmounted, ref } from 'vue';
import { storeToRefs } from 'pinia';

import type { FileNode } from '@shared/types';

import { useFilesStore } from '../../stores/files';
import { useUiStore } from '../../stores/ui';
import FileChangesModal from './FileChangesModal.vue';
import FileTreeItem from './FileTreeItem.vue';
import ContextMenu, { type ContextMenuItem } from '../shared/ContextMenu.vue';
import Spinner from '../shared/Spinner.vue';
import Icon from '../shared/Icon.vue';
import { logger } from '../../utils/logger';

const filesStore = useFilesStore();
const uiStore = useUiStore();
const { fileTree, hasFiles, hasWorkingDirectory, isLoading, error } = storeToRefs(filesStore);

const rootRef = ref<HTMLElement | null>(null);

function handleFileSelect(path: string) {
  logger.debug('File selected', { path });
  // Could open in editor, show preview, etc.
}

// The viewer itself is mounted at app level and its state lives in the ui
// store, because /memory opens CLAUDE.md in the same one and this sidebar may
// be hidden at the time.
function handleViewMarkdown(path: string) {
  uiStore.openMarkdownViewer(path);
}

function refresh() {
  filesStore.loadFileTree();
}

// Right-click menu on a file or a folder.
const menu = ref<{ node: FileNode; x: number; y: number } | null>(null);
/** The file whose changes are shown, while they are. */
const changesOf = ref<string | null>(null);

function openMenu(node: FileNode, x: number, y: number): void {
  menu.value = { node, x, y };
}

/** A path as relative to the working directory, with forward slashes. */
function relativePath(path: string): string {
  const base = (filesStore.workingDirectory ?? '').replace(/[\\/]+$/, '');
  const relative = path.startsWith(base) ? path.slice(base.length).replace(/^[\\/]+/, '') : path;
  return relative.replace(/\\/g, '/');
}

async function copy(text: string): Promise<void> {
  try {
    await window.electron.clipboard.writeText(text);
  } catch (error) {
    logger.error('Failed to copy to the clipboard', error);
  }
}

async function showInFolder(path: string): Promise<void> {
  const result = await window.electron.files.showInFolder(path);
  if (!result.success) logger.error('Failed to show in the file manager', { path, error: result.error });
}

const menuItems = computed<ContextMenuItem[]>(() => {
  const node = menu.value?.node;
  if (!node) return [];
  const copies: ContextMenuItem[] = [
    { label: 'Copy path', onSelect: () => copy(node.path) },
    { label: 'Copy relative path', onSelect: () => copy(relativePath(node.path)) },
  ];
  if (node.type === 'directory') {
    return [
      // A folder opened by the system opens in the file manager.
      { label: 'Open in file manager', onSelect: () => filesStore.openFile(node.path) },
      ...copies,
    ];
  }
  return [
    { label: 'Open with default app', onSelect: () => filesStore.openFile(node.path) },
    { label: 'Show in file manager', onSelect: () => showInFolder(node.path) },
    { label: 'Show changes', onSelect: () => { changesOf.value = node.path; } },
    ...copies,
  ];
});

// Deselect when the user clicks anywhere outside the file tree — matches
// the convention in OS file explorers and signals that the selection only
// reflects file-tree interaction.
function handleDocumentClick(event: MouseEvent): void {
  if (!filesStore.selectedFile) return;
  const root = rootRef.value;
  if (!root) return;
  const target = event.target as Node | null;
  if (target && root.contains(target)) return;
  filesStore.selectFile(null);
}

onMounted(() => {
  document.addEventListener('mousedown', handleDocumentClick);
});

onUnmounted(() => {
  document.removeEventListener('mousedown', handleDocumentClick);
});
</script>

<template>
  <div
    ref="rootRef"
    class="flex flex-col h-full min-h-0"
  >
    <!-- Header -->
    <div class="flex items-center justify-between px-3 py-2 border-b border-surface-200 dark:border-surface-700">
      <span class="text-xs font-medium uppercase text-surface-500 dark:text-surface-400">
        Files
      </span>
      <button
        class="btn-icon p-1"
        title="Refresh"
        :disabled="isLoading"
        @click="refresh"
      >
        <Icon
          name="refresh"
          size="sm"
          :class="isLoading ? 'animate-spin' : ''"
        />
      </button>
    </div>

    <!-- Content -->
    <div class="flex-1 min-h-0 overflow-y-auto py-1">
      <!-- Loading state -->
      <div
        v-if="isLoading && !hasFiles"
        class="flex items-center justify-center h-full"
      >
        <Spinner size="md" />
      </div>

      <!-- Error state -->
      <div
        v-else-if="error"
        class="flex flex-col items-center justify-center h-full px-4 text-center"
      >
        <Icon
          name="warning"
          size="lg"
          class="text-red-500 mb-2"
        />
        <p class="text-sm text-surface-500 dark:text-surface-400">
          {{ error }}
        </p>
      </div>

      <!-- Empty state. An empty tree means one of two different things:
           no directory has been chosen yet, or a directory is chosen and
           genuinely contains nothing. Reporting "no directory selected" for
           the second case is simply untrue. -->
      <div
        v-else-if="!hasFiles"
        class="flex flex-col items-center justify-center h-full px-4 text-center"
      >
        <Icon
          name="folder"
          size="lg"
          class="text-surface-300 dark:text-surface-600 mb-2"
        />
        <p class="text-sm text-surface-500 dark:text-surface-400">
          {{ hasWorkingDirectory ? 'This folder is empty' : 'No working directory selected' }}
        </p>
        <p
          v-if="hasWorkingDirectory"
          class="text-xs text-surface-400 dark:text-surface-500 mt-1"
        >
          Claude can still create files here.
        </p>
      </div>

      <!-- File tree -->
      <div v-else>
        <FileTreeItem
          v-for="node in fileTree"
          :key="node.path"
          :node="node"
          @select="handleFileSelect"
          @view-markdown="handleViewMarkdown"
          @menu="openMenu"
        />
      </div>
    </div>

    <ContextMenu
      :open="menu !== null"
      :x="menu?.x ?? 0"
      :y="menu?.y ?? 0"
      :items="menuItems"
      @close="menu = null"
    />
    <FileChangesModal
      :open="changesOf !== null"
      :file-path="changesOf"
      :working-directory="filesStore.workingDirectory"
      @close="changesOf = null"
    />
  </div>
</template>
