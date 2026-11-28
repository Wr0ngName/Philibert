<script setup lang="ts">
/**
 * Active permissions audit dropdown.
 *
 * Shows the permissions currently in force for the current conversation:
 * - session-scoped grants for this conversation (held in the main process)
 * - project-scoped allow rules and directories from the working directory's
 *   `.claude/settings.local.json` and `.claude/settings.json`
 *
 * Session grants and local project entries can be revoked individually. Shared
 * project entries (`settings.json`, usually committed) are listed read-only.
 * Displayed as a shield icon with badge in the header bar.
 *
 * It also holds the discussion's sandbox: whether its shell commands run
 * confined to its folder or not (DiscussionSettings.sandboxed), and so which
 * of its shell grants are in force and how far they reach. The shield turns
 * red while the discussion runs unsandboxed.
 */

import { SANDBOXED_SHELL_SUMMARY, UNSANDBOXED_SHELL_SUMMARY } from '@shared/sandbox';
import { SHELL_TOOLS, sessionEntryTitle } from '@shared/session-permissions';
import type { ProjectPermissionEntry, SessionPermissionEntry } from '@shared/types';
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';

import { useChatStore } from '../../stores/chat';
import { useConversationsStore } from '../../stores/conversations';
import { useMcpStore } from '../../stores/mcp';
import { useSettingsStore } from '../../stores/settings';
import { useUiStore } from '../../stores/ui';
import { formatTime } from '../../utils/date';
import { logger } from '../../utils/logger';
import { projectEntryDetail, projectEntrySourceLabel, projectEntryTitle } from '../../utils/project-permissions';
import TransitionFade from './TransitionFade.vue';

/** Project settings files whose changes can alter the project permissions. */
const PROJECT_SETTINGS_FILE = /[\\/]\.claude[\\/]settings(\.local)?\.json$/;

const chatStore = useChatStore();
const conversationsStore = useConversationsStore();
const settingsStore = useSettingsStore();
const mcpStore = useMcpStore();

const isOpen = ref(false);
const dropdownRef = ref<HTMLDivElement | null>(null);
const projectPermissions = ref<ProjectPermissionEntry[]>([]);

// Computed: current conversation's session permissions
const permissions = computed(() => chatStore.sessionPermissions);
const hasSessionPermissions = computed(() => chatStore.hasSessionPermissions);
const hasProjectPermissions = computed(() => projectPermissions.value.length > 0);
const permissionCount = computed(() => chatStore.sessionPermissionCount + projectPermissions.value.length);
const hasPermissions = computed(() => permissionCount.value > 0);

/** Whether a discussion is open whose sandbox can be set (with none, there is nothing to set it on). */
const hasDiscussion = computed(() => !!conversationsStore.currentConversationId);
const sandboxed = computed(() => conversationsStore.currentSettings.sandboxed);

/** Run the discussion's shell commands in the sandbox or not, from its next message on. */
async function setSandboxed(value: boolean): Promise<void> {
  try {
    await conversationsStore.setCurrentSettings({ sandboxed: value });
  } catch (err) {
    logger.error('Failed to change the discussion sandbox', { error: err });
  }
}

/**
 * How far a session grant reaches, as its badge says. Out of the sandbox, a
 * grant made inside it for a shell command — its rule, or the mode and
 * directories that came with it — is "inactive": not given to the session
 * (entryInForce). A shell rule otherwise reaches inside the sandbox while
 * the discussion runs in it ("sandboxed"), anywhere while it does not
 * ("unrestricted"). Null for any other grant: the sandbox does not confine it.
 */
function shellReach(perm: SessionPermissionEntry): { label: string; title: string; tone: string } | null {
  if (!sandboxed.value && perm.sandboxed) {
    return {
      label: 'inactive',
      title: 'Granted inside the sandbox: not in force while this discussion runs unsandboxed. What it allowed asks again.',
      tone: 'bg-surface-200 text-surface-600 dark:bg-surface-700 dark:text-surface-300',
    };
  }
  if (perm.kind !== 'rule' || !SHELL_TOOLS.has(perm.toolName)) return null;
  if (sandboxed.value) {
    return { label: 'sandboxed', title: SANDBOXED_SHELL_SUMMARY, tone: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300' };
  }
  return { label: 'unrestricted', title: UNSANDBOXED_SHELL_SUMMARY, tone: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300' };
}

/** Settings → Project: this project's tools and what it allows without asking. */
function openProjectSettings(): void {
  isOpen.value = false;
  useUiStore().openProjectSettings();
}

/**
 * Revoke a permission
 */
async function revokePermission(permissionId: string): Promise<void> {
  const currentConvId = conversationsStore.currentConversationId;
  if (!currentConvId) return;
  try {
    await window.electron.claude.revokeSessionPermission(currentConvId, permissionId);
  } catch (err) {
    logger.error('Failed to revoke session permission', { error: err });
  }
}

/**
 * Remove a project entry from `.claude/settings.local.json`
 */
async function revokeProjectPermission(entry: ProjectPermissionEntry): Promise<void> {
  const workingDirectory = settingsStore.workingDirectory;
  if (!workingDirectory) return;
  try {
    projectPermissions.value = await window.electron.claude.revokeProjectPermission(
      workingDirectory,
      entry.kind,
      entry.value,
    );
  } catch (err) {
    logger.error('Failed to revoke project permission', { error: err });
  }
}

/**
 * Re-read the project permissions of the current working directory
 */
async function loadProjectPermissions(): Promise<void> {
  const workingDirectory = settingsStore.workingDirectory;
  if (!workingDirectory) {
    projectPermissions.value = [];
    return;
  }
  try {
    projectPermissions.value = await window.electron.claude.getProjectPermissions(workingDirectory);
  } catch (err) {
    logger.warn('Failed to load project permissions', { error: err });
  }
}

/**
 * Load permissions when conversation changes
 */
watch(
  () => conversationsStore.currentConversationId,
  async (newId) => {
    if (newId) {
      try {
        const perms = await window.electron.claude.getSessionPermissions(newId);
        chatStore.updateSessionPermissions(newId, perms);
      } catch (err) {
        logger.warn('Failed to load session permissions', { error: err });
      }
    }
  },
  { immediate: true }
);

watch(() => settingsStore.workingDirectory, loadProjectPermissions, { immediate: true });

function toggleDropdown(): void {
  isOpen.value = !isOpen.value;
  if (isOpen.value) {
    void loadProjectPermissions();
  }
}

function handleClickOutside(event: MouseEvent): void {
  if (dropdownRef.value && !dropdownRef.value.contains(event.target as Node)) {
    isOpen.value = false;
  }
}

// "Allow in project" is persisted by the CLI after the approval returns, and
// users edit these files by hand too, so follow the working-directory watcher.
let stopWatchingFiles: (() => void) | null = null;

onMounted(() => {
  document.addEventListener('click', handleClickOutside);
  stopWatchingFiles = window.electron.files.onChange((changes) => {
    if (changes.some((change) => PROJECT_SETTINGS_FILE.test(change.path))) {
      void loadProjectPermissions();
    }
  });
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
  stopWatchingFiles?.();
  stopWatchingFiles = null;
});
</script>

<template>
  <div
    ref="dropdownRef"
    class="relative"
  >
    <!-- Shield button with badge -->
    <button
      class="btn-icon relative"
      :class="{ 'bg-surface-200 dark:bg-surface-700': isOpen, 'text-red-500 dark:text-red-400': hasDiscussion && !sandboxed }"
      :title="(hasPermissions
        ? `${permissionCount} permission${permissionCount !== 1 ? 's' : ''} active`
        : 'No active permissions')
        + (hasDiscussion && !sandboxed ? ' — shell commands not sandboxed' : '')"
      data-testid="permissions-shield"
      @click.stop="toggleDropdown"
    >
      <svg
        class="w-5 h-5"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
        />
      </svg>
      <!-- Badge showing count -->
      <span
        v-if="hasPermissions"
        class="absolute -top-1 -right-1 w-4 h-4 bg-blue-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center"
      >
        {{ permissionCount > 9 ? '9+' : permissionCount }}
      </span>
    </button>

    <!-- Dropdown -->
    <TransitionFade type="scale">
      <div
        v-if="isOpen"
        class="absolute right-0 top-full mt-1 z-50 min-w-[260px] max-w-[340px] rounded-lg shadow-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 py-1 overflow-hidden"
      >
        <!-- Header -->
        <div class="px-3 py-2 border-b border-surface-200 dark:border-surface-700">
          <h3 class="text-sm font-medium text-surface-800 dark:text-surface-200">
            Active Permissions
          </h3>
          <p class="text-xs text-surface-500 dark:text-surface-400 mt-0.5">
            Granted for this conversation and project
          </p>
        </div>

        <!-- The discussion's sandbox -->
        <div
          v-if="hasDiscussion"
          class="px-3 py-2 border-b border-surface-200 dark:border-surface-700"
          data-testid="sandbox-section"
        >
          <label class="flex items-center justify-between gap-2 cursor-pointer">
            <span class="text-sm font-medium text-surface-800 dark:text-surface-200">Sandbox shell commands</span>
            <input
              type="checkbox"
              class="shrink-0"
              data-testid="sandbox-toggle"
              :checked="sandboxed"
              @change="setSandboxed(($event.target as HTMLInputElement).checked)"
            >
          </label>
          <p
            :class="['text-xs mt-1', sandboxed ? 'text-surface-500 dark:text-surface-400' : 'text-red-600 dark:text-red-400']"
            data-testid="sandbox-summary"
          >
            {{ sandboxed ? SANDBOXED_SHELL_SUMMARY : UNSANDBOXED_SHELL_SUMMARY }}
          </p>
          <p class="text-xs text-surface-400 dark:text-surface-500 mt-0.5">
            For this discussion only, from its next message.
          </p>
        </div>

        <!-- Empty state -->
        <div
          v-if="!hasPermissions"
          class="px-3 py-4 text-sm text-surface-500 dark:text-surface-400 text-center"
        >
          <svg
            class="w-6 h-6 mx-auto mb-2 opacity-30"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
            />
          </svg>
          <p>No active permissions</p>
          <p class="text-xs mt-1">
            Permissions granted via "Always Allow" will appear here
          </p>
        </div>

        <!-- Permission lists -->
        <div
          v-else
          class="max-h-[300px] overflow-y-auto"
        >
          <template v-if="hasSessionPermissions">
            <div
              data-testid="session-permissions-heading"
              class="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-surface-400 dark:text-surface-500"
            >
              Session
            </div>
            <div
              v-for="perm in permissions"
              :key="perm.id"
              class="flex items-center gap-2 px-3 py-2 hover:bg-surface-50 dark:hover:bg-surface-700 group"
            >
              <div class="shrink-0">
                <span
                  class="inline-block w-2 h-2 rounded-full bg-blue-400"
                  title="Session scope"
                />
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-surface-800 dark:text-surface-200 flex items-center gap-1.5">
                  <span class="truncate">{{ sessionEntryTitle(perm) }}</span>
                  <span
                    v-if="shellReach(perm)"
                    :class="['shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-sm', shellReach(perm)!.tone]"
                    :title="shellReach(perm)!.title"
                    data-testid="shell-reach"
                  >{{ shellReach(perm)!.label }}</span>
                </div>
                <div class="text-xs text-surface-500 dark:text-surface-400 truncate">
                  {{ perm.description }}
                </div>
                <div class="text-xs text-surface-400 dark:text-surface-500">
                  Granted at {{ formatTime(perm.grantedAt) }}
                </div>
              </div>
              <button
                class="shrink-0 p-1 rounded-sm hover:bg-red-100 dark:hover:bg-red-900/30 text-surface-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Revoke this permission"
                @click="revokePermission(perm.id)"
              >
                <svg
                  class="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          </template>

          <template v-if="hasProjectPermissions">
            <div
              data-testid="project-permissions-heading"
              class="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-surface-400 dark:text-surface-500"
            >
              Project
            </div>
            <div
              v-for="entry in projectPermissions"
              :key="`${entry.source}:${entry.kind}:${entry.value}`"
              data-testid="project-permission"
              class="flex items-center gap-2 px-3 py-2 hover:bg-surface-50 dark:hover:bg-surface-700 group"
            >
              <div class="shrink-0">
                <span
                  class="inline-block w-2 h-2 rounded-full bg-yellow-400"
                  title="Project scope"
                />
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-surface-800 dark:text-surface-200">
                  {{ projectEntryTitle(entry) }}
                </div>
                <div
                  class="text-xs text-surface-500 dark:text-surface-400 truncate"
                  :title="projectEntryDetail(entry)"
                >
                  {{ projectEntryDetail(entry) }}
                </div>
                <div class="text-xs text-surface-400 dark:text-surface-500 truncate">
                  {{ projectEntrySourceLabel(entry) }}
                </div>
              </div>
              <button
                v-if="entry.source === 'local'"
                data-testid="revoke-project-permission"
                class="shrink-0 p-1 rounded-sm hover:bg-red-100 dark:hover:bg-red-900/30 text-surface-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Remove from .claude/settings.local.json"
                @click="revokeProjectPermission(entry)"
              >
                <svg
                  class="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          </template>
        </div>

        <!-- Everything this project has of its own, in one place: not for one Settings does not list. -->
        <button
          v-if="mcpStore.currentProjectListed"
          type="button"
          data-testid="open-project-settings"
          class="w-full px-3 py-2 border-t border-surface-200 dark:border-surface-700 text-left text-xs text-primary-600 dark:text-primary-400 hover:bg-surface-50 dark:hover:bg-surface-700"
          @click="openProjectSettings"
        >
          Open Project settings
        </button>
      </div>
    </TransitionFade>
  </div>
</template>
