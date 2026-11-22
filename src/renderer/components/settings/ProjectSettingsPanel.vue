<script setup lang="ts">
/**
 * Settings → Project: what one project has of its own — its tool servers,
 * the global tools it turns off for itself, and what it lets Claude do
 * without asking.
 *
 * About the open discussion's folder unless another is picked: the page opens
 * on a header naming the folder it edits, so "this project" is never a guess.
 */

import { computed } from 'vue';
import { storeToRefs } from 'pinia';

import { useMcpStore } from '../../stores/mcp';
import { baseName } from '../../utils/path';
import Icon from '../shared/Icon.vue';
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

const projectName = computed(() => (projectDir.value ? baseName(projectDir.value) : null));
</script>

<template>
  <div class="project-settings space-y-6">
    <!-- Which project, said first and set apart: everything below is its own. -->
    <div class="project-settings-header">
      <div class="flex items-start gap-3">
        <Icon
          name="folder"
          size="lg"
          class="shrink-0 text-primary-600 dark:text-primary-400"
        />
        <div class="min-w-0 flex-1">
          <div class="project-settings-name">
            {{ projectName ?? 'No project folder' }}
          </div>
          <div
            v-if="projectDir"
            class="project-settings-path"
            :title="projectDir"
          >
            {{ projectDir }}
          </div>
        </div>
      </div>
      <p class="text-xs text-surface-600 dark:text-surface-300 mt-2">
        These settings apply to this project only, and take effect as you change them.
      </p>
      <div
        v-if="hasProject && projectChoices.length > 1"
        class="flex items-center gap-2 mt-3"
      >
        <label
          for="project-settings-folder"
          class="text-xs font-medium text-surface-600 dark:text-surface-300 shrink-0"
        >
          Another project
        </label>
        <select
          id="project-settings-folder"
          v-model="selected"
          class="min-w-0 flex-1 px-2 py-1 text-xs rounded border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100"
        >
          <option
            v-for="dir in projectChoices"
            :key="dir"
            :value="dir"
          >
            {{ dir }}
          </option>
        </select>
      </div>
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

<style scoped>
@reference "../../assets/styles/main.css";
.project-settings-header {
  @apply p-4 rounded-lg border border-primary-200 dark:border-primary-800 bg-primary-50 dark:bg-primary-900/20;
}

.project-settings-name {
  @apply text-base font-semibold text-surface-900 dark:text-surface-100 truncate;
}

.project-settings-path {
  @apply text-xs font-mono text-surface-500 dark:text-surface-400 truncate;
}
</style>
