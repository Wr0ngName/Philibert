<script setup lang="ts">
/**
 * File tree item component - recursive file/directory display
 */

import { computed } from 'vue';

import type { FileNode } from '@shared/types';
import type { IconName } from '../shared/Icon.vue';

import { useChatStore } from '../../stores/chat';
import { useFilesStore } from '../../stores/files';
import Icon from '../shared/Icon.vue';
import TransitionFade from '../shared/TransitionFade.vue';

interface Props {
  /** File or directory node to render */
  node: FileNode;
  /** Nesting depth for indentation (0 = root level) */
  depth?: number;
}

const props = withDefaults(defineProps<Props>(), {
  depth: 0,
});

const emit = defineEmits<{
  (e: 'select', path: string): void;
  (e: 'view-markdown', path: string): void;
  /** Right-clicked: the panel shows its menu for this node, there. */
  (e: 'menu', node: FileNode, x: number, y: number): void;
}>();

function openMenu(event: MouseEvent): void {
  event.preventDefault();
  emit('menu', props.node, event.clientX, event.clientY);
}

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx']);

function isMarkdownFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext !== undefined && MARKDOWN_EXTS.has(ext);
}

const filesStore = useFilesStore();
const chatStore = useChatStore();

const isDirectory = computed(() => props.node.type === 'directory');
const wasModifiedInLastQuery = computed(() => {
  if (isDirectory.value) return false;
  return chatStore.modifiedFilesInLastQuery.has(props.node.path);
});
const isExpanded = computed(() => filesStore.isDirectoryExpanded(props.node.path));
const isReading = computed(() => isDirectory.value && filesStore.isDirectoryLoading(props.node.path));

/**
 * A closed directory with a file changed somewhere inside it: its changed
 * files are hidden, so the directory says so instead. From the changed
 * paths, not the tree's rows — the tree only holds what has been opened.
 */
const holdsModified = computed(() => {
  if (!isDirectory.value || isExpanded.value) return false;
  const prefix = props.node.path.replace(/[\\/]+$/, '');
  for (const changed of chatStore.modifiedFilesInLastQuery) {
    if (changed.startsWith(`${prefix}/`) || changed.startsWith(`${prefix}\\`)) return true;
  }
  return false;
});
const isSelected = computed(() => filesStore.selectedFile === props.node.path);

const icon = computed((): IconName => {
  if (isDirectory.value) {
    return isExpanded.value ? 'folder-open' : 'folder';
  }

  // File icons based on extension
  const ext = props.node.name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'vue':
    case 'json':
      return 'code';
    case 'md':
      return 'document';
    default:
      return 'file';
  }
});

function handleClick() {
  if (isDirectory.value) {
    filesStore.toggleDirectory(props.node.path);
  } else {
    filesStore.selectFile(props.node.path);
    if (isMarkdownFile(props.node.name)) {
      // Render inline instead of shelling out to the OS default handler.
      emit('view-markdown', props.node.path);
    } else {
      filesStore.openFile(props.node.path);
    }
    emit('select', props.node.path);
  }
}
</script>

<template>
  <div>
    <button
      :class="[
        'w-full flex items-center gap-2 px-2 py-1 text-left text-sm rounded-sm hover:bg-surface-200 dark:hover:bg-surface-700 transition-colors',
        isSelected && !isDirectory ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300' : 'text-surface-700 dark:text-surface-300',
      ]"
      :style="{ paddingLeft: `${depth * 12 + 8}px` }"
      @click="handleClick"
      @contextmenu="openMenu"
    >
      <!-- Expand/collapse chevron for directories -->
      <Icon
        v-if="isDirectory"
        name="chevron-right"
        size="xs"
        :class="[
          'transition-transform shrink-0',
          isExpanded ? 'rotate-90' : '',
        ]"
      />
      <span
        v-else
        class="w-3"
      />

      <!-- Icon -->
      <Icon
        :name="icon"
        size="sm"
        :class="[
          'shrink-0',
          isDirectory ? 'text-yellow-500' : 'text-surface-400',
        ]"
      />

      <!-- Name -->
      <span class="truncate">{{ node.name }}</span>

      <!-- Modified in last query indicator: a dot on the file, a ring on a
           closed folder holding one -->
      <span
        v-if="wasModifiedInLastQuery"
        class="modified-marker w-2 h-2 rounded-full bg-blue-500 shrink-0 ml-auto"
        title="Modified in last query"
      />
      <span
        v-else-if="holdsModified"
        class="modified-inside-marker w-2 h-2 rounded-full border-2 border-blue-500 shrink-0 ml-auto"
        title="Holds files modified in last query"
      />
    </button>

    <!-- Children (recursive) -->
    <TransitionFade type="collapse">
      <div
        v-if="isDirectory && isExpanded && node.children"
        class="overflow-hidden"
      >
        <FileTreeItem
          v-for="child in node.children"
          :key="child.path"
          :node="child"
          :depth="depth + 1"
          @select="emit('select', $event)"
          @view-markdown="emit('view-markdown', $event)"
          @menu="(node, x, y) => emit('menu', node, x, y)"
        />
      </div>
    </TransitionFade>
    <!-- Opened, its entries on their way -->
    <div
      v-if="isExpanded && !node.children && isReading"
      class="directory-reading text-xs text-surface-400 py-1"
      :style="{ paddingLeft: `${(depth + 1) * 12 + 28}px` }"
    >
      Loading…
    </div>
  </div>
</template>
