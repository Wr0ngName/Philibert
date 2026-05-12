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
}>();

const filesStore = useFilesStore();
const chatStore = useChatStore();

const isDirectory = computed(() => props.node.type === 'directory');
const wasModifiedInLastQuery = computed(() => {
  if (isDirectory.value) return false;
  return chatStore.modifiedFilesInLastQuery.has(props.node.path);
});
const isExpanded = computed(() => filesStore.isDirectoryExpanded(props.node.path));
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
    filesStore.openFile(props.node.path);
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

      <!-- Modified in last query indicator -->
      <span
        v-if="wasModifiedInLastQuery"
        class="w-2 h-2 rounded-full bg-blue-500 shrink-0 ml-auto"
        title="Modified in last query"
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
        />
      </div>
    </TransitionFade>
  </div>
</template>
