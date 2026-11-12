<script setup lang="ts">
/**
 * Settings → Project: what one project has of its own — its tool servers,
 * the global tools it turns off for itself, and what it lets Claude do
 * without asking.
 *
 * About the open discussion's folder unless another is picked: the page says
 * which folder it edits, so "this project" is never a guess.
 */

import { computed } from 'vue';
import { storeToRefs } from 'pinia';

import { useMcpStore } from '../../stores/mcp';
import McpServersPanel from './McpServersPanel.vue';
import ProjectPermissionsList from './ProjectPermissionsList.vue';
import ProjectToolsList from './ProjectToolsList.vue';

const emit = defineEmits<{
  (e: 'open-global'): void;
}>();

const mcpStore = useMcpStore();
const { projectDir, projectChoices, hasProject } = storeToRefs(mcpStore);

const selected = computed({
  get: () => projectDir.value ?? '',
  set: (dir: string) => mcpStore.pickProject(dir || null),
});
</script>

<template>
  <div class="project-settings space-y-6">
    <div>
      <label
        for="project-settings-folder"
        class="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1"
      >
        Project
      </label>
      <select
        v-if="hasProject"
        id="project-settings-folder"
        v-model="selected"
        class="w-full px-2 py-1.5 text-sm rounded border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100"
      >
        <option
          v-for="dir in projectChoices"
          :key="dir"
          :value="dir"
        >
          {{ dir }}
        </option>
      </select>
      <p class="text-xs text-surface-500 dark:text-surface-400 mt-1">
        The settings below apply to this folder only. It is the open discussion's unless you pick another.
      </p>
    </div>

    <div
      v-if="!hasProject"
      class="p-3 rounded-lg border border-surface-300 dark:border-surface-600 text-xs text-surface-500 dark:text-surface-400"
    >
      Choose a project folder first: open a discussion, or pick a folder in the files panel.
    </div>

    <template v-else>
      <McpServersPanel scope="project" />
      <ProjectToolsList @open-global="emit('open-global')" />
      <ProjectPermissionsList />
    </template>
  </div>
</template>
