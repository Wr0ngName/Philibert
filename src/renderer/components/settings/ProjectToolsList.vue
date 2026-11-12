<script setup lang="ts">
/**
 * The tools every project has — claude.ai connectors and the user's own
 * servers — as the project being set up has them: on, turned off in this
 * project, or off in global settings, which wins (the switch is not there:
 * Claude Code does not even list such a tool, so it can only be turned back
 * on in Settings → Tools).
 */

import { computed, onMounted, watch } from 'vue';
import { storeToRefs } from 'pinia';

import { useMcpStore } from '../../stores/mcp';
import { displayName, PROJECT_TOOL_STATE_LABEL, projectToolRows } from '../../utils/global-tools';
import Button from '../shared/Button.vue';
import Icon from '../shared/Icon.vue';

const emit = defineEmits<{
  (e: 'open-global'): void;
}>();

const mcpStore = useMcpStore();
const { projectTools, isCheckingProject, projectToolsError, toolBusy, projectDir } = storeToRefs(mcpStore);

onMounted(() => {
  void mcpStore.checkProjectTools();
});
watch(projectDir, () => {
  void mcpStore.checkProjectTools();
});

const rows = computed(() => (projectTools.value ? projectToolRows(projectTools.value) : []));
const available = computed(() => projectTools.value?.statuses !== null);
const busy = computed(() => toolBusy.value !== null || isCheckingProject.value);

const STATE_CLASSES = {
  'off-everywhere': 'bg-surface-200 dark:bg-surface-700 text-surface-500 dark:text-surface-400',
  'off-here': 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
  on: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300',
} as const;
</script>

<template>
  <div class="project-tools">
    <div class="flex items-start justify-between gap-3 mb-2">
      <div>
        <h3 class="text-sm font-medium text-surface-700 dark:text-surface-300">
          Tools from your global settings
        </h3>
        <p class="text-xs text-surface-500 dark:text-surface-400 mt-0.5">
          claude.ai connectors and your own servers. This project can turn one off for itself;
          one off in global settings stays off here.
        </p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        :loading="isCheckingProject"
        :disabled="busy"
        @click="mcpStore.checkProjectTools()"
      >
        Check again
      </Button>
    </div>

    <div
      v-if="projectToolsError"
      class="mb-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-800 dark:text-red-200 flex items-start gap-2"
    >
      <Icon
        name="error"
        size="xs"
        class="mt-0.5 shrink-0"
      />
      <span>{{ projectToolsError }}</span>
    </div>

    <div
      v-if="projectTools === null && isCheckingProject"
      class="text-xs text-surface-500 dark:text-surface-400 py-2"
    >
      Checking… this starts Claude Code briefly in this project and takes a few seconds.
    </div>

    <div
      v-else-if="projectTools && !available"
      class="p-3 rounded-lg border border-dashed border-surface-300 dark:border-surface-600 text-xs text-surface-500 dark:text-surface-400"
    >
      Sign in to Claude to see how this project has them.
    </div>

    <div
      v-else-if="projectTools && rows.length === 0"
      class="p-3 rounded-lg border border-dashed border-surface-300 dark:border-surface-600 text-xs text-surface-500 dark:text-surface-400"
    >
      None: no claude.ai connectors, and no servers of your own.
    </div>

    <ul
      v-else-if="projectTools"
      class="space-y-2"
    >
      <li
        v-for="row in rows"
        :key="row.name"
        class="project-tool p-3 rounded-lg border border-surface-300 dark:border-surface-600"
        :data-tool="row.name"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span class="text-sm font-medium text-surface-800 dark:text-surface-200 whitespace-nowrap">
                {{ displayName(row.name) }}
              </span>
              <span class="text-[11px] text-surface-500 dark:text-surface-400 whitespace-nowrap">
                {{ row.kind === 'connector' ? 'claude.ai connector' : 'your server' }}
              </span>
              <span
                class="project-tool-state text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded whitespace-nowrap"
                :class="STATE_CLASSES[row.state]"
              >
                {{ PROJECT_TOOL_STATE_LABEL[row.state] }}
              </span>
            </div>
            <p
              v-if="row.state === 'off-everywhere'"
              class="text-xs text-surface-500 dark:text-surface-400 mt-1"
            >
              Turned off for every project.
              <button
                type="button"
                class="underline hover:text-primary-600 dark:hover:text-primary-400"
                @click="emit('open-global')"
              >
                Change it in Tools
              </button>
            </p>
          </div>
          <Button
            v-if="row.state !== 'off-everywhere' && row.status && row.status.status !== 'pending'"
            variant="ghost"
            size="sm"
            class="project-tool-switch shrink-0"
            :loading="toolBusy === row.name"
            :disabled="busy"
            @click="mcpStore.setEnabledInProject(row.name, row.state === 'off-here')"
          >
            {{ row.state === 'off-here' ? 'Turn on here' : 'Turn off here' }}
          </Button>
        </div>
      </li>
    </ul>
  </div>
</template>
