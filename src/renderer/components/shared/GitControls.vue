<script setup lang="ts">
/**
 * Git controls for the header bar.
 * Shows branch name, commit/pull/push buttons when working directory is a git repo.
 * Status updates are event-driven via fs.watch on .git/ internals.
 */

import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { storeToRefs } from 'pinia';

import type { GitStatus } from '@shared/types';
import { useSettingsStore } from '../../stores/settings';
import { logger } from '../../utils/logger';
import Icon from './Icon.vue';
import Spinner from './Spinner.vue';
import TransitionFade from './TransitionFade.vue';

const settingsStore = useSettingsStore();
const { workingDirectory } = storeToRefs(settingsStore);

// Git status state
const status = ref<GitStatus | null>(null);
const isGitRepo = computed(() => status.value?.isGitRepo ?? false);

// UI state
const commitDropdownOpen = ref(false);
const commitMessage = ref('');
const stageAll = ref(true);
const commitDropdownRef = ref<HTMLDivElement | null>(null);

// Loading/error state per operation
const loadingCommit = ref(false);
const loadingPull = ref(false);
const loadingPush = ref(false);
const errorMessage = ref('');
let errorTimer: ReturnType<typeof setTimeout> | null = null;

// IPC cleanup
let cleanupStatusListener: (() => void) | null = null;

function showError(msg: string): void {
  errorMessage.value = msg;
  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    errorMessage.value = '';
  }, 4000);
}

async function fetchStatus(): Promise<void> {
  if (!workingDirectory.value) {
    status.value = null;
    return;
  }
  try {
    const result = await window.electron.git.status(workingDirectory.value);
    status.value = result;
  } catch (err) {
    logger.warn('Failed to fetch git status', { error: err });
    status.value = null;
  }
}

/**
 * Background git fetch to update remote tracking refs.
 * After fetch completes, refresh status for accurate ahead/behind counts.
 */
async function backgroundFetch(): Promise<void> {
  if (!workingDirectory.value) return;
  try {
    await window.electron.git.fetch(workingDirectory.value);
    // Re-fetch status after remote refs updated
    await fetchStatus();
  } catch {
    // Fetch failures are non-critical (offline, no remote, etc.)
  }
}

async function doCommit(): Promise<void> {
  if (!workingDirectory.value || !commitMessage.value.trim()) return;
  loadingCommit.value = true;
  try {
    await window.electron.git.commit(workingDirectory.value, commitMessage.value.trim(), stageAll.value);
    commitMessage.value = '';
    commitDropdownOpen.value = false;
    await fetchStatus();
  } catch (err) {
    showError(`Commit failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    loadingCommit.value = false;
  }
}

async function doPull(): Promise<void> {
  if (!workingDirectory.value) return;
  loadingPull.value = true;
  try {
    await window.electron.git.pull(workingDirectory.value);
    await fetchStatus();
  } catch (err) {
    showError(`Pull failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    loadingPull.value = false;
  }
}

async function doPush(): Promise<void> {
  if (!workingDirectory.value) return;
  loadingPush.value = true;
  try {
    await window.electron.git.push(workingDirectory.value);
    await fetchStatus();
  } catch (err) {
    showError(`Push failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    loadingPush.value = false;
  }
}

function toggleCommitDropdown(): void {
  commitDropdownOpen.value = !commitDropdownOpen.value;
}

function handleClickOutside(event: MouseEvent): void {
  if (commitDropdownRef.value && !commitDropdownRef.value.contains(event.target as Node)) {
    commitDropdownOpen.value = false;
  }
}

function handleCommitKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && commitMessage.value.trim()) {
    event.preventDefault();
    doCommit();
  }
  if (event.key === 'Escape') {
    commitDropdownOpen.value = false;
  }
}

// Watch working directory changes
watch(workingDirectory, () => {
  fetchStatus();
  // Background fetch to update remote tracking refs for new directory
  backgroundFetch();
});

onMounted(() => {
  fetchStatus();
  // Background fetch on mount so ahead/behind counts are accurate
  backgroundFetch();
  document.addEventListener('click', handleClickOutside);

  // Listen for event-driven git status changes
  cleanupStatusListener = window.electron.git.onStatusChanged((newStatus) => {
    status.value = newStatus;
  });
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
  if (cleanupStatusListener) {
    cleanupStatusListener();
  }
  if (errorTimer) {
    clearTimeout(errorTimer);
  }
});
</script>

<template>
  <div
    v-if="isGitRepo && status"
    class="flex items-center gap-1"
  >
    <!-- Branch pill -->
    <div
      class="flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-surface-100 dark:bg-surface-700 text-surface-600 dark:text-surface-400"
      title="Current branch"
    >
      <Icon
        name="git-branch"
        size="xs"
      />
      <span class="max-w-[80px] truncate">{{ status.branch }}</span>
      <!-- Dirty indicator -->
      <span
        v-if="status.dirty > 0"
        class="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"
        :title="`${status.dirty} uncommitted change${status.dirty !== 1 ? 's' : ''}`"
      />
    </div>

    <!-- Commit button (with dropdown) -->
    <div
      ref="commitDropdownRef"
      class="relative"
    >
      <button
        class="btn-icon relative"
        :class="{ 'bg-surface-200 dark:bg-surface-700': commitDropdownOpen }"
        :disabled="loadingCommit"
        title="Commit changes"
        @click.stop="toggleCommitDropdown"
      >
        <Spinner
          v-if="loadingCommit"
          size="xs"
        />
        <Icon
          v-else
          name="git-commit"
          size="sm"
        />
        <!-- Dirty count badge -->
        <span
          v-if="status.dirty > 0 && !loadingCommit"
          class="absolute -top-1 -right-1 min-w-[16px] h-4 px-0.5 bg-amber-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center"
        >
          {{ status.dirty > 99 ? '99+' : status.dirty }}
        </span>
      </button>

      <!-- Commit dropdown -->
      <TransitionFade type="scale">
        <div
          v-if="commitDropdownOpen"
          class="absolute right-0 top-full mt-1 z-50 w-[280px] rounded-lg shadow-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 p-3 overflow-hidden"
        >
          <div class="text-sm font-medium text-surface-800 dark:text-surface-200 mb-2">
            Commit Changes
          </div>

          <input
            v-model="commitMessage"
            type="text"
            class="w-full px-2.5 py-1.5 text-sm rounded-md border border-surface-300 dark:border-surface-600 bg-surface-50 dark:bg-surface-900 text-surface-800 dark:text-surface-200 placeholder-surface-400 dark:placeholder-surface-500 focus:outline-hidden focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
            placeholder="Commit message..."
            :disabled="loadingCommit"
            @keydown="handleCommitKeydown"
          >

          <!-- Stage all toggle -->
          <label class="flex items-center gap-2 mt-2 cursor-pointer select-none">
            <input
              v-model="stageAll"
              type="checkbox"
              class="w-3.5 h-3.5 rounded-sm border-surface-300 dark:border-surface-600 text-primary-500 focus:ring-primary-500"
            >
            <span class="text-xs text-surface-600 dark:text-surface-400">
              Stage all changes
            </span>
          </label>

          <button
            class="w-full mt-2 px-3 py-1.5 text-sm rounded-md bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            :disabled="!commitMessage.trim() || loadingCommit"
            @click="doCommit"
          >
            <span v-if="loadingCommit">Committing...</span>
            <span v-else>{{ stageAll ? 'Commit all' : 'Commit staged' }}</span>
          </button>
        </div>
      </TransitionFade>
    </div>

    <!-- Pull button -->
    <button
      class="btn-icon relative"
      :disabled="loadingPull"
      title="Pull from remote"
      @click="doPull"
    >
      <Spinner
        v-if="loadingPull"
        size="xs"
      />
      <Icon
        v-else
        name="git-pull"
        size="sm"
      />
      <!-- Behind count badge -->
      <span
        v-if="status.behind > 0 && !loadingPull"
        class="absolute -top-1 -right-1 min-w-[16px] h-4 px-0.5 bg-blue-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center"
      >
        {{ status.behind > 99 ? '99+' : status.behind }}
      </span>
    </button>

    <!-- Push button -->
    <button
      class="btn-icon relative"
      :disabled="loadingPush"
      title="Push to remote"
      @click="doPush"
    >
      <Spinner
        v-if="loadingPush"
        size="xs"
      />
      <Icon
        v-else
        name="git-push"
        size="sm"
      />
      <!-- Ahead count badge -->
      <span
        v-if="status.ahead > 0 && !loadingPush"
        class="absolute -top-1 -right-1 min-w-[16px] h-4 px-0.5 bg-green-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center"
      >
        {{ status.ahead > 99 ? '99+' : status.ahead }}
      </span>
    </button>

    <!-- Error toast -->
    <TransitionFade>
      <div
        v-if="errorMessage"
        class="fixed top-14 right-4 z-50 max-w-sm px-3 py-2 rounded-lg bg-red-500 text-white text-sm shadow-lg"
      >
        {{ errorMessage }}
      </div>
    </TransitionFade>
  </div>
</template>
