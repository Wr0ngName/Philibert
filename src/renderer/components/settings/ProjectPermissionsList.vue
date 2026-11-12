<script setup lang="ts">
/**
 * What the project allows Claude without asking — "Allow in project" in an
 * approval, kept in `.claude/settings.local.json` — and the rules in the
 * shared `.claude/settings.json`, which apply just the same. The local ones
 * can be revoked; the shared ones, usually committed for a team, are listed
 * read-only (ProjectPermissionService).
 */

import { onMounted, ref, watch } from 'vue';

import type { ProjectPermissionEntry } from '@shared/types';

import { useMcpStore } from '../../stores/mcp';
import { logger } from '../../utils/logger';
import { projectEntryDetail, projectEntrySourceLabel, projectEntryTitle } from '../../utils/project-permissions';
import Button from '../shared/Button.vue';

const mcpStore = useMcpStore();

const entries = ref<ProjectPermissionEntry[] | null>(null);
const error = ref<string | null>(null);
const busy = ref<string | null>(null);

const keyOf = (entry: ProjectPermissionEntry) => `${entry.source}:${entry.kind}:${entry.value}`;

async function load(): Promise<void> {
  error.value = null;
  const dir = mcpStore.projectDir;
  if (!dir) {
    entries.value = null;
    return;
  }
  try {
    entries.value = await window.electron.claude.getProjectPermissions(dir);
  } catch (err) {
    logger.warn('Failed to load project permissions', { error: err });
    error.value = "This project's permissions could not be read.";
  }
}

async function revoke(entry: ProjectPermissionEntry): Promise<void> {
  const dir = mcpStore.projectDir;
  if (!dir) return;
  busy.value = keyOf(entry);
  error.value = null;
  try {
    entries.value = await window.electron.claude.revokeProjectPermission(dir, entry.kind, entry.value);
  } catch (err) {
    logger.error('Failed to revoke project permission', { error: err });
    error.value = 'The permission could not be removed.';
  } finally {
    busy.value = null;
  }
}

onMounted(load);
watch(() => mcpStore.projectDir, load);
</script>

<template>
  <div class="project-permissions">
    <h3 class="text-sm font-medium text-surface-700 dark:text-surface-300">
      Allowed without asking
    </h3>
    <p class="text-xs text-surface-500 dark:text-surface-400 mt-0.5 mb-2">
      What you chose "Allow in project" for. Claude does these in this project without asking first.
    </p>

    <p
      v-if="error"
      class="mb-2 text-xs text-red-700 dark:text-red-300"
      role="alert"
    >
      {{ error }}
    </p>

    <div
      v-if="entries && entries.length === 0"
      class="p-3 rounded-lg border border-dashed border-surface-300 dark:border-surface-600 text-xs text-surface-500 dark:text-surface-400"
    >
      Nothing yet: Claude asks before each action that needs your approval.
    </div>

    <ul
      v-else-if="entries"
      class="space-y-1"
    >
      <li
        v-for="entry in entries"
        :key="keyOf(entry)"
        class="project-permission flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-surface-300 dark:border-surface-600"
      >
        <div class="min-w-0">
          <div class="text-sm font-medium text-surface-800 dark:text-surface-200">
            {{ projectEntryTitle(entry) }}
          </div>
          <div
            class="text-xs text-surface-500 dark:text-surface-400 truncate"
            :title="projectEntryDetail(entry)"
          >
            {{ projectEntryDetail(entry) }}
          </div>
          <div class="text-[11px] text-surface-400 dark:text-surface-500 truncate">
            {{ projectEntrySourceLabel(entry) }}
          </div>
        </div>
        <Button
          v-if="entry.source === 'local'"
          variant="ghost"
          size="sm"
          class="shrink-0"
          :loading="busy === keyOf(entry)"
          :disabled="busy !== null"
          @click="revoke(entry)"
        >
          Remove
        </Button>
      </li>
    </ul>
  </div>
</template>
