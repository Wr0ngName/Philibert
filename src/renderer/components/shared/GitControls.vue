<script setup lang="ts">
/**
 * Git controls for the header bar.
 * Shows branch name, commit/pull/push buttons when working directory is a git repo.
 * The branch pill doubles as a branch switcher (local + remote-tracking).
 * Status updates are event-driven via fs.watch on .git/ internals.
 */

import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { storeToRefs } from 'pinia';

import type { GitBranch, GitStatus } from '@shared/types';
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

// Monotonic epoch so a slow fetchStatus can't overwrite a newer status that
// arrived in the meantime (either a more recent fetch or a push from main
// via onStatusChanged). Bumped on every initiated read and on every event.
let statusEpoch = 0;

// Commit dropdown state
const commitDropdownOpen = ref(false);
const commitMessage = ref('');
const stageAll = ref(true);
const commitOnNewBranch = ref(false);
const newBranchName = ref('');
const commitDropdownRef = ref<HTMLDivElement | null>(null);

// Branch dropdown state
const branchDropdownOpen = ref(false);
const branchDropdownRef = ref<HTMLDivElement | null>(null);
const branches = ref<GitBranch[]>([]);
const branchFilter = ref('');
const branchFilterInputRef = ref<HTMLInputElement | null>(null);
const createBranchMode = ref(false);
const createBranchName = ref('');
const createBranchInputRef = ref<HTMLInputElement | null>(null);
const loadingBranches = ref(false);
const branchLoadError = ref('');
const switchingBranch = ref<string | null>(null);
const loadingCreateBranch = ref(false);

// Loading/error state per operation
const loadingCommit = ref(false);
const loadingPull = ref(false);
const loadingPush = ref(false);
const errorMessage = ref('');
let errorTimer: ReturnType<typeof setTimeout> | null = null;

// IPC cleanup
let cleanupStatusListener: (() => void) | null = null;

// Cross-disable: while any mutation is in flight, no new mutation should be
// initiated. Prevents push during checkout, commit during pull, etc. — any of
// which could otherwise leave the displayed branch out of sync with HEAD.
const isMutating = computed(
  () =>
    loadingCommit.value ||
    loadingPull.value ||
    loadingPush.value ||
    loadingCreateBranch.value ||
    switchingBranch.value !== null
);

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
  const myEpoch = ++statusEpoch;
  try {
    const result = await window.electron.git.status(workingDirectory.value);
    if (myEpoch !== statusEpoch) return; // a newer status arrived; drop this one
    status.value = result;
  } catch (err) {
    if (myEpoch !== statusEpoch) return;
    logger.warn('Failed to fetch git status', { error: err });
    status.value = null;
  }
}

/**
 * Refetch status synchronously and verify the on-disk branch still matches
 * what we're displaying. Updates the display to the fresh value either way.
 * Returns true iff the displayed branch is consistent with HEAD so the caller
 * can proceed. On mismatch (e.g. user switched branches in a terminal between
 * status events), surfaces a toast and returns false so the operation is
 * aborted — the user must click again with full knowledge of the new state.
 */
async function ensureBranchConsistent(): Promise<boolean> {
  if (!workingDirectory.value) {
    showError('No working directory set');
    return false;
  }
  const before = status.value?.branch;
  let fresh: GitStatus;
  try {
    fresh = await window.electron.git.status(workingDirectory.value);
  } catch (err) {
    showError(`Failed to verify git status: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  // Apply the fresh read as the new displayed truth (bump epoch so any older
  // in-flight fetch drops its result).
  ++statusEpoch;
  status.value = fresh.isGitRepo ? fresh : null;
  if (!fresh.isGitRepo) {
    showError('Working directory is no longer a git repository.');
    return false;
  }
  if (before !== undefined && fresh.branch !== before) {
    showError(
      `Branch changed to "${fresh.branch}" since the UI last refreshed. Confirm and click again.`
    );
    return false;
  }
  return true;
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

async function loadBranches(): Promise<void> {
  if (!workingDirectory.value) return;
  loadingBranches.value = true;
  branchLoadError.value = '';
  try {
    branches.value = await window.electron.git.listBranches(workingDirectory.value);
  } catch (err) {
    logger.warn('Failed to list branches', { error: err });
    branches.value = [];
    // Surface explicitly — an empty list and a load failure mean very
    // different things to a user about to switch branches.
    branchLoadError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loadingBranches.value = false;
  }
}

const filteredLocalBranches = computed(() =>
  branches.value
    .filter((b) => !b.isRemote && b.name.toLowerCase().includes(branchFilter.value.toLowerCase()))
);

const filteredRemoteBranches = computed(() => {
  const localNames = new Set(branches.value.filter((b) => !b.isRemote).map((b) => b.name));
  return branches.value.filter((b) => {
    if (!b.isRemote) return false;
    // Hide remotes whose short name (after the remote prefix) already exists locally —
    // checking out a tracking ref when a local exists is redundant noise.
    const localPart = b.name.substring(b.name.indexOf('/') + 1);
    if (localNames.has(localPart)) return false;
    return b.name.toLowerCase().includes(branchFilter.value.toLowerCase());
  });
});

async function doCommit(): Promise<void> {
  if (!workingDirectory.value || !commitMessage.value.trim() || isMutating.value) return;
  if (commitOnNewBranch.value && !newBranchName.value.trim()) {
    showError('Enter a branch name or uncheck "Commit on a new branch"');
    return;
  }
  loadingCommit.value = true;
  try {
    if (!(await ensureBranchConsistent())) return;
    const branchAtClick = status.value?.branch ?? '';
    if (commitOnNewBranch.value) {
      const newBranch = newBranchName.value.trim();
      await window.electron.git.createBranch(workingDirectory.value, newBranch, true);
      // After createBranch HEAD is the new branch; commit must run there.
      await window.electron.git.commit(
        workingDirectory.value,
        commitMessage.value.trim(),
        stageAll.value,
        newBranch
      );
    } else {
      await window.electron.git.commit(
        workingDirectory.value,
        commitMessage.value.trim(),
        stageAll.value,
        branchAtClick
      );
    }
    commitMessage.value = '';
    newBranchName.value = '';
    commitOnNewBranch.value = false;
    commitDropdownOpen.value = false;
    await fetchStatus();
  } catch (err) {
    showError(`Commit failed: ${err instanceof Error ? err.message : String(err)}`);
    // Status may be out of sync after a partial failure (e.g. created branch
    // but commit failed) — refresh so the displayed branch reflects reality.
    await fetchStatus();
  } finally {
    loadingCommit.value = false;
  }
}

async function doPull(): Promise<void> {
  if (!workingDirectory.value || isMutating.value) return;
  loadingPull.value = true;
  try {
    if (!(await ensureBranchConsistent())) return;
    const branchAtClick = status.value?.branch ?? '';
    await window.electron.git.pull(workingDirectory.value, branchAtClick);
    await fetchStatus();
  } catch (err) {
    showError(`Pull failed: ${err instanceof Error ? err.message : String(err)}`);
    await fetchStatus();
  } finally {
    loadingPull.value = false;
  }
}

async function doPush(): Promise<void> {
  if (!workingDirectory.value || isMutating.value) return;
  loadingPush.value = true;
  try {
    if (!(await ensureBranchConsistent())) return;
    const branchAtClick = status.value?.branch ?? '';
    await window.electron.git.push(workingDirectory.value, branchAtClick);
    await fetchStatus();
  } catch (err) {
    showError(`Push failed: ${err instanceof Error ? err.message : String(err)}`);
    await fetchStatus();
  } finally {
    loadingPush.value = false;
  }
}

async function doCheckout(branchName: string): Promise<void> {
  if (!workingDirectory.value || isMutating.value) return;
  if (status.value?.branch === branchName) {
    branchDropdownOpen.value = false;
    return;
  }
  switchingBranch.value = branchName;
  try {
    await window.electron.git.checkout(workingDirectory.value, branchName);
    branchDropdownOpen.value = false;
    branchFilter.value = '';
    await fetchStatus();
  } catch (err) {
    showError(`Checkout failed: ${err instanceof Error ? err.message : String(err)}`);
    await fetchStatus();
  } finally {
    switchingBranch.value = null;
  }
}

async function doCreateBranchFromPicker(): Promise<void> {
  if (!workingDirectory.value || !createBranchName.value.trim() || isMutating.value) return;
  loadingCreateBranch.value = true;
  try {
    // Ensure the displayed "from <branch>" label matches HEAD — otherwise the
    // new branch would silently fork from a different parent than the user
    // expects.
    if (!(await ensureBranchConsistent())) return;
    await window.electron.git.createBranch(
      workingDirectory.value,
      createBranchName.value.trim(),
      true
    );
    createBranchName.value = '';
    createBranchMode.value = false;
    branchDropdownOpen.value = false;
    branchFilter.value = '';
    await fetchStatus();
  } catch (err) {
    showError(`Create branch failed: ${err instanceof Error ? err.message : String(err)}`);
    await fetchStatus();
  } finally {
    loadingCreateBranch.value = false;
  }
}

async function toggleBranchDropdown(): Promise<void> {
  // Closing
  if (branchDropdownOpen.value) {
    branchDropdownOpen.value = false;
    return;
  }
  // Refuse to open while another mutation is in flight — opening would imply
  // imminent checkout, which we can't safely interleave with push/pull/commit.
  if (isMutating.value) return;
  // Opening
  branchDropdownOpen.value = true;
  commitDropdownOpen.value = false;
  branchFilter.value = '';
  createBranchMode.value = false;
  createBranchName.value = '';
  branchLoadError.value = '';
  await loadBranches();
  await nextTick();
  branchFilterInputRef.value?.focus();
}

async function enterCreateBranchMode(): Promise<void> {
  createBranchMode.value = true;
  createBranchName.value = branchFilter.value.trim();
  await nextTick();
  createBranchInputRef.value?.focus();
}

function exitCreateBranchMode(): void {
  createBranchMode.value = false;
  createBranchName.value = '';
}

function toggleCommitDropdown(): void {
  commitDropdownOpen.value = !commitDropdownOpen.value;
  if (commitDropdownOpen.value) {
    branchDropdownOpen.value = false;
  }
}

function handleClickOutside(event: MouseEvent): void {
  const target = event.target as Node;
  if (commitDropdownRef.value && !commitDropdownRef.value.contains(target)) {
    commitDropdownOpen.value = false;
  }
  if (branchDropdownRef.value && !branchDropdownRef.value.contains(target)) {
    branchDropdownOpen.value = false;
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

function handleBranchFilterKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    branchDropdownOpen.value = false;
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    const first = filteredLocalBranches.value[0] ?? filteredRemoteBranches.value[0];
    if (first) {
      doCheckout(first.name);
    } else if (branchFilter.value.trim()) {
      // No match — offer the typed name as a new-branch target
      enterCreateBranchMode();
    }
  }
}

function handleCreateBranchKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && createBranchName.value.trim()) {
    event.preventDefault();
    doCreateBranchFromPicker();
  }
  if (event.key === 'Escape') {
    exitCreateBranchMode();
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
    // Newer than any in-flight fetchStatus — bump so they drop their results.
    ++statusEpoch;
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
    <!-- Branch pill (also branch switcher) -->
    <div
      ref="branchDropdownRef"
      class="relative"
    >
      <button
        class="flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-surface-100 dark:bg-surface-700 text-surface-600 dark:text-surface-400 hover:bg-surface-200 dark:hover:bg-surface-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        :class="{ 'bg-surface-200 dark:bg-surface-600': branchDropdownOpen }"
        :disabled="isMutating && switchingBranch === null"
        :title="`Switch or create branch (current: ${status.branch})`"
        @click.stop="toggleBranchDropdown"
      >
        <Icon
          name="git-branch"
          size="xs"
        />
        <span class="max-w-[120px] truncate">{{ status.branch }}</span>
        <!-- Dirty indicator -->
        <span
          v-if="status.dirty > 0"
          class="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"
          :title="`${status.dirty} uncommitted change${status.dirty !== 1 ? 's' : ''}`"
        />
        <Icon
          name="chevron-down"
          size="xs"
          class="opacity-60"
        />
      </button>

      <!-- Branch dropdown -->
      <TransitionFade type="scale">
        <div
          v-if="branchDropdownOpen"
          class="absolute right-0 top-full mt-1 z-50 w-[300px] rounded-lg shadow-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 overflow-hidden"
        >
          <!-- Search input -->
          <div class="p-2 border-b border-surface-200 dark:border-surface-700">
            <input
              ref="branchFilterInputRef"
              v-model="branchFilter"
              type="text"
              class="w-full px-2.5 py-1.5 text-sm rounded-md border border-surface-300 dark:border-surface-600 bg-surface-50 dark:bg-surface-900 text-surface-800 dark:text-surface-200 placeholder-surface-400 dark:placeholder-surface-500 focus:outline-hidden focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
              placeholder="Filter branches..."
              :disabled="createBranchMode"
              @keydown="handleBranchFilterKeydown"
            >
          </div>

          <!-- Loading state -->
          <div
            v-if="loadingBranches"
            class="px-3 py-4 flex items-center justify-center text-surface-500 dark:text-surface-400 text-xs"
          >
            <Spinner size="xs" />
            <span class="ml-2">Loading branches...</span>
          </div>

          <!-- Error state — distinguished from an empty list so the user
               doesn't act on stale/missing data. Retry re-runs loadBranches. -->
          <div
            v-else-if="branchLoadError"
            class="px-3 py-3 text-xs"
          >
            <div class="text-red-600 dark:text-red-400 mb-2">
              Failed to load branches: {{ branchLoadError }}
            </div>
            <button
              class="px-2 py-1 text-xs rounded-md bg-surface-100 dark:bg-surface-700 hover:bg-surface-200 dark:hover:bg-surface-600 text-surface-700 dark:text-surface-300 transition-colors"
              @click="loadBranches"
            >
              Retry
            </button>
          </div>

          <!-- Branch list -->
          <div
            v-else
            class="max-h-[280px] overflow-y-auto"
          >
            <!-- Local branches -->
            <div
              v-if="filteredLocalBranches.length > 0"
              class="py-1"
            >
              <div class="px-3 py-1 text-[10px] uppercase tracking-wide text-surface-400 dark:text-surface-500 font-medium">
                Local
              </div>
              <button
                v-for="branch in filteredLocalBranches"
                :key="`local-${branch.name}`"
                class="w-full px-3 py-1.5 flex items-center gap-2 text-left text-sm hover:bg-surface-100 dark:hover:bg-surface-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                :disabled="switchingBranch !== null"
                @click="doCheckout(branch.name)"
              >
                <Icon
                  v-if="status.branch === branch.name"
                  name="check"
                  size="xs"
                  class="text-primary-500 shrink-0"
                />
                <span
                  v-else
                  class="w-3 shrink-0"
                />
                <span
                  class="flex-1 truncate"
                  :class="status.branch === branch.name
                    ? 'text-surface-900 dark:text-surface-100 font-medium'
                    : 'text-surface-700 dark:text-surface-300'"
                >{{ branch.name }}</span>
                <Spinner
                  v-if="switchingBranch === branch.name"
                  size="xs"
                />
                <span
                  v-else-if="branch.upstream"
                  class="text-[10px] text-surface-400 dark:text-surface-500 truncate max-w-[80px]"
                  :title="`tracks ${branch.upstream}`"
                >
                  {{ branch.upstream }}
                </span>
              </button>
            </div>

            <!-- Remote branches -->
            <div
              v-if="filteredRemoteBranches.length > 0"
              class="py-1 border-t border-surface-100 dark:border-surface-700/50"
            >
              <div class="px-3 py-1 text-[10px] uppercase tracking-wide text-surface-400 dark:text-surface-500 font-medium">
                Remote
              </div>
              <button
                v-for="branch in filteredRemoteBranches"
                :key="`remote-${branch.name}`"
                class="w-full px-3 py-1.5 flex items-center gap-2 text-left text-sm hover:bg-surface-100 dark:hover:bg-surface-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                :disabled="switchingBranch !== null"
                :title="`Create local tracking branch from ${branch.name}`"
                @click="doCheckout(branch.name)"
              >
                <Icon
                  name="git-pull"
                  size="xs"
                  class="text-surface-400 dark:text-surface-500 shrink-0"
                />
                <span class="flex-1 truncate text-surface-700 dark:text-surface-300">{{ branch.name }}</span>
                <Spinner
                  v-if="switchingBranch === branch.name"
                  size="xs"
                />
              </button>
            </div>

            <!-- Empty state -->
            <div
              v-if="filteredLocalBranches.length === 0 && filteredRemoteBranches.length === 0"
              class="px-3 py-4 text-center text-xs text-surface-500 dark:text-surface-400"
            >
              <template v-if="branchFilter">
                No branches match "{{ branchFilter }}"
              </template>
              <template v-else>
                No branches
              </template>
            </div>
          </div>

          <!-- Create new branch action / form -->
          <div class="border-t border-surface-200 dark:border-surface-700 p-2">
            <template v-if="!createBranchMode">
              <button
                class="w-full px-2 py-1.5 flex items-center gap-2 text-sm rounded-md hover:bg-surface-100 dark:hover:bg-surface-700 transition-colors text-surface-700 dark:text-surface-300"
                @click="enterCreateBranchMode"
              >
                <Icon
                  name="plus"
                  size="xs"
                />
                <span class="flex-1 text-left">
                  Create new branch from <span class="font-medium">{{ status.branch }}</span>
                </span>
              </button>
            </template>
            <template v-else>
              <div class="flex items-center gap-2">
                <input
                  ref="createBranchInputRef"
                  v-model="createBranchName"
                  type="text"
                  class="flex-1 px-2 py-1 text-sm rounded-md border border-surface-300 dark:border-surface-600 bg-surface-50 dark:bg-surface-900 text-surface-800 dark:text-surface-200 placeholder-surface-400 dark:placeholder-surface-500 focus:outline-hidden focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="new-branch-name"
                  :disabled="loadingCreateBranch"
                  @keydown="handleCreateBranchKeydown"
                >
                <button
                  class="px-2 py-1 text-xs rounded-md bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  :disabled="!createBranchName.trim() || loadingCreateBranch"
                  @click="doCreateBranchFromPicker"
                >
                  <Spinner
                    v-if="loadingCreateBranch"
                    size="xs"
                  />
                  <span v-else>Create</span>
                </button>
                <button
                  class="px-2 py-1 text-xs rounded-md text-surface-500 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700 transition-colors"
                  :disabled="loadingCreateBranch"
                  @click="exitCreateBranchMode"
                >
                  Cancel
                </button>
              </div>
            </template>
          </div>
        </div>
      </TransitionFade>
    </div>

    <!-- Commit button (with dropdown) -->
    <div
      ref="commitDropdownRef"
      class="relative"
    >
      <button
        class="btn-icon relative"
        :class="{ 'bg-surface-200 dark:bg-surface-700': commitDropdownOpen }"
        :disabled="isMutating && !loadingCommit"
        :title="`Commit changes on ${status.branch}`"
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
          class="absolute right-0 top-full mt-1 z-50 w-[300px] rounded-lg shadow-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 p-3 overflow-hidden"
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

          <!-- Commit on a new branch toggle -->
          <label class="flex items-center gap-2 mt-1.5 cursor-pointer select-none">
            <input
              v-model="commitOnNewBranch"
              type="checkbox"
              class="w-3.5 h-3.5 rounded-sm border-surface-300 dark:border-surface-600 text-primary-500 focus:ring-primary-500"
            >
            <span class="text-xs text-surface-600 dark:text-surface-400">
              Commit on a new branch
            </span>
          </label>

          <input
            v-if="commitOnNewBranch"
            v-model="newBranchName"
            type="text"
            class="w-full mt-1.5 px-2.5 py-1.5 text-sm rounded-md border border-surface-300 dark:border-surface-600 bg-surface-50 dark:bg-surface-900 text-surface-800 dark:text-surface-200 placeholder-surface-400 dark:placeholder-surface-500 focus:outline-hidden focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
            placeholder="new-branch-name"
            :disabled="loadingCommit"
            @keydown="handleCommitKeydown"
          >

          <button
            class="w-full mt-2 px-3 py-1.5 text-sm rounded-md bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            :disabled="!commitMessage.trim() || (commitOnNewBranch && !newBranchName.trim()) || loadingCommit"
            @click="doCommit"
          >
            <span v-if="loadingCommit">Committing...</span>
            <span v-else-if="commitOnNewBranch">{{ stageAll ? 'Create branch & commit all' : 'Create branch & commit staged' }}</span>
            <span v-else>{{ stageAll ? 'Commit all' : 'Commit staged' }}</span>
          </button>
        </div>
      </TransitionFade>
    </div>

    <!-- Pull button -->
    <button
      class="btn-icon relative"
      :disabled="isMutating && !loadingPull"
      :title="`Pull ${status.branch} from remote`"
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
      :disabled="isMutating && !loadingPush"
      :title="`Push ${status.branch} to remote`"
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
