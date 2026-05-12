<script setup lang="ts">
/**
 * Root application component
 */

import { ref, onMounted, onUnmounted, watch } from 'vue';
import { storeToRefs } from 'pinia';

import { useSettingsStore } from './stores/settings';
import { useFilesStore } from './stores/files';
import { useConversationsStore } from './stores/conversations';
import ChatWindow from './components/chat/ChatWindow.vue';
import WorkingDirectory from './components/files/WorkingDirectory.vue';
import FileTree from './components/files/FileTree.vue';
import ConversationHistory from './components/conversations/ConversationHistory.vue';
import SettingsPanel from './components/settings/SettingsPanel.vue';
import InitWizard from './components/wizard/InitWizard.vue';
import ErrorBoundary from './components/shared/ErrorBoundary.vue';
import UpdateBanner from './components/shared/UpdateBanner.vue';
import GitControls from './components/shared/GitControls.vue';
import ModelSelector from './components/shared/ModelSelector.vue';
import SessionPermissionsDropdown from './components/shared/SessionPermissionsDropdown.vue';

const settingsStore = useSettingsStore();
const filesStore = useFilesStore();
const conversationsStore = useConversationsStore();
const { isLoading, needsSetup, hasCompletedInitialSetup, showHistorySidebar, showFilesSidebar } = storeToRefs(settingsStore);

const showSettings = ref(false);
const showWizard = ref(false);
const sidebarWidth = ref(280);
const historyWidth = ref(240);

// Initialize stores on mount
onMounted(() => {
  settingsStore.initialize();
  filesStore.initialize();
  conversationsStore.initialize();
});

// Show wizard ONLY on initial app load when setup is needed
// Do NOT show wizard after logout - user can use Settings panel to re-authenticate
// The hasCompletedInitialSetup flag is persisted in config, so it survives app restarts
watch(
  [isLoading, needsSetup, hasCompletedInitialSetup],
  ([loading, needs, completed]) => {
    // Only show wizard on initial load, not after logout
    // Once user completes wizard, the persisted flag prevents showing it again
    if (!loading && needs && !completed) {
      showWizard.value = true;
    }
  },
  { immediate: true }
);

// Cleanup on unmount
onUnmounted(() => {
  settingsStore.cleanup();
  filesStore.cleanup();
  conversationsStore.cleanup();
});

async function onWizardComplete() {
  showWizard.value = false;
  // Persist the completion flag so wizard doesn't show again after logout
  await settingsStore.setHasCompletedInitialSetup(true);
  // Reload config and files after wizard completes
  settingsStore.loadConfig();
  filesStore.initialize();
}

function openSettings() {
  showSettings.value = true;
}

function closeSettings() {
  showSettings.value = false;
}

function toggleHistory() {
  settingsStore.setShowHistorySidebar(!showHistorySidebar.value);
}

function toggleFiles() {
  settingsStore.setShowFilesSidebar(!showFilesSidebar.value);
}

// Window controls
function minimize() {
  window.electron?.window.minimize();
}

function maximize() {
  window.electron?.window.maximize();
}

function close() {
  window.electron?.window.close();
}

const isMac = window.electron?.platform === 'darwin';
</script>

<template>
  <ErrorBoundary>
    <div class="h-screen flex flex-col bg-surface-50 dark:bg-surface-900">
      <!-- Header -->
      <header class="header flex items-center gap-4 drag-region">
        <!-- macOS traffic lights space -->
        <div
          v-if="isMac"
          class="w-16"
        />

        <!-- Logo & Title -->
        <div class="flex items-center gap-2 no-drag">
          <div class="w-8 h-8 rounded-lg bg-primary-500 flex items-center justify-center">
            <svg
              class="w-5 h-5 text-white"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
          </div>
          <h1 class="text-lg font-semibold text-surface-800 dark:text-surface-200">
            Philibert
          </h1>
        </div>

        <!-- Spacer -->
        <div class="flex-1" />

        <!-- Actions -->
        <div class="flex items-center gap-2 no-drag">
          <!-- Git Controls -->
          <GitControls />

          <!-- Model Selector -->
          <ModelSelector />

          <!-- Session Permissions -->
          <SessionPermissionsDropdown />

          <button
            class="btn-icon"
            :class="{ 'bg-surface-200 dark:bg-surface-700': showHistorySidebar }"
            title="Toggle conversation history"
            @click="toggleHistory"
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
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </button>
          <button
            class="btn-icon"
            :class="{ 'bg-surface-200 dark:bg-surface-700': showFilesSidebar }"
            title="Toggle file browser"
            @click="toggleFiles"
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
                d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
              />
            </svg>
          </button>
          <button
            class="btn-icon"
            title="Settings"
            @click="openSettings"
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
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </button>
        </div>

        <!-- Windows controls (non-macOS) -->
        <div
          v-if="!isMac"
          class="flex items-center no-drag"
        >
          <button
            class="btn-icon"
            title="Minimize"
            @click="minimize"
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
                d="M20 12H4"
              />
            </svg>
          </button>
          <button
            class="btn-icon"
            title="Maximize"
            @click="maximize"
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
                d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
              />
            </svg>
          </button>
          <button
            class="btn-icon hover:bg-red-500 hover:text-white"
            title="Close"
            @click="close"
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
      </header>

      <!-- Update notification banner -->
      <UpdateBanner />

      <!-- Main content -->
      <main class="flex-1 flex overflow-hidden">
        <!-- Conversation History Sidebar -->
        <Transition
          enter-active-class="transition-all duration-200 ease-out"
          enter-from-class="w-0 opacity-0"
          enter-to-class="opacity-100"
          leave-active-class="transition-all duration-150 ease-in"
          leave-from-class="opacity-100"
          leave-to-class="w-0 opacity-0"
        >
          <aside
            v-if="showHistorySidebar"
            class="history-sidebar flex flex-col border-r border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-900"
            :style="{ width: `${historyWidth}px` }"
          >
            <ConversationHistory />
          </aside>
        </Transition>

        <!-- Files Sidebar -->
        <Transition
          enter-active-class="transition-all duration-200 ease-out"
          enter-from-class="w-0 opacity-0"
          enter-to-class="opacity-100"
          leave-active-class="transition-all duration-150 ease-in"
          leave-from-class="opacity-100"
          leave-to-class="w-0 opacity-0"
        >
          <aside
            v-if="showFilesSidebar"
            class="sidebar flex flex-col"
            :style="{ width: `${sidebarWidth}px` }"
          >
            <WorkingDirectory />
            <FileTree class="flex-1" />
          </aside>
        </Transition>

        <!-- Chat area -->
        <section class="flex-1 min-w-0 flex flex-col relative bg-white dark:bg-surface-800">
          <ChatWindow />
        </section>
      </main>

      <!-- Settings Modal -->
      <SettingsPanel
        :open="showSettings"
        @close="closeSettings"
      />

      <!-- Initial Setup Wizard -->
      <InitWizard
        v-if="showWizard"
        @complete="onWizardComplete"
      />
    </div>
  </ErrorBoundary>
</template>
