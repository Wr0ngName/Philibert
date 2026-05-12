<script setup lang="ts">
/**
 * Update notification banner component
 * Shows when updates are available, downloading, or ready to install
 */

import { ref, onMounted, onUnmounted } from 'vue';

interface UpdateInfo {
  version: string;
  releaseNotes?: string;
  releaseDate?: string;
}

interface UpdateProgress {
  percent: number;
  bytesPerSecond: number;
  total: number;
  transferred: number;
}

const updateAvailable = ref<UpdateInfo | null>(null);
const isDownloading = ref(false);
const downloadProgress = ref<UpdateProgress | null>(null);
const isDownloaded = ref(false);
const dismissed = ref(false);

let cleanupAvailable: (() => void) | null = null;
let cleanupProgress: (() => void) | null = null;
let cleanupDownloaded: (() => void) | null = null;

onMounted(() => {
  // Listen for update events
  cleanupAvailable = window.electron?.update.onAvailable((info: UpdateInfo) => {
    updateAvailable.value = info;
    dismissed.value = false;
  });

  cleanupProgress = window.electron?.update.onProgress((progress: UpdateProgress) => {
    downloadProgress.value = progress;
  });

  cleanupDownloaded = window.electron?.update.onDownloaded(() => {
    isDownloading.value = false;
    isDownloaded.value = true;
  });
});

onUnmounted(() => {
  cleanupAvailable?.();
  cleanupProgress?.();
  cleanupDownloaded?.();
});

async function downloadUpdate() {
  isDownloading.value = true;
  downloadProgress.value = { percent: 0, bytesPerSecond: 0, total: 0, transferred: 0 };
  await window.electron?.update.download();
}

function installUpdate() {
  window.electron?.update.install();
}

function dismiss() {
  dismissed.value = true;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<template>
  <Transition
    enter-active-class="transition-all duration-300 ease-out"
    enter-from-class="-translate-y-full opacity-0"
    enter-to-class="translate-y-0 opacity-100"
    leave-active-class="transition-all duration-200 ease-in"
    leave-from-class="translate-y-0 opacity-100"
    leave-to-class="-translate-y-full opacity-0"
  >
    <div
      v-if="updateAvailable && !dismissed"
      class="update-banner"
    >
      <!-- Update available - not yet downloading -->
      <template v-if="!isDownloading && !isDownloaded">
        <div class="flex items-center gap-2">
          <svg
            class="w-5 h-5 text-primary-600 dark:text-primary-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
            />
          </svg>
          <span class="font-medium">
            Update available: v{{ updateAvailable.version }}
          </span>
        </div>
        <div class="flex items-center gap-2">
          <button
            class="btn-sm btn-primary"
            @click="downloadUpdate"
          >
            Download
          </button>
          <button
            class="btn-sm btn-ghost"
            @click="dismiss"
          >
            Later
          </button>
        </div>
      </template>

      <!-- Downloading -->
      <template v-else-if="isDownloading && !isDownloaded">
        <div class="flex items-center gap-3 flex-1">
          <svg
            class="w-5 h-5 text-primary-600 dark:text-primary-400 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              class="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              stroke-width="4"
            />
            <path
              class="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <div class="flex-1">
            <div class="flex items-center justify-between text-sm">
              <span>Downloading v{{ updateAvailable.version }}...</span>
              <span>{{ downloadProgress?.percent?.toFixed(0) || 0 }}%</span>
            </div>
            <div class="mt-1 h-1.5 bg-surface-200 dark:bg-surface-700 rounded-full overflow-hidden">
              <div
                class="h-full bg-primary-500 transition-all duration-200"
                :style="{ width: `${downloadProgress?.percent || 0}%` }"
              />
            </div>
            <div
              v-if="downloadProgress?.bytesPerSecond"
              class="mt-1 text-xs text-surface-500"
            >
              {{ formatBytes(downloadProgress.transferred) }} / {{ formatBytes(downloadProgress.total) }}
              ({{ formatBytes(downloadProgress.bytesPerSecond) }}/s)
            </div>
          </div>
        </div>
      </template>

      <!-- Downloaded - ready to install -->
      <template v-else-if="isDownloaded">
        <div class="flex items-center gap-2">
          <svg
            class="w-5 h-5 text-green-600 dark:text-green-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <span class="font-medium">
            Update v{{ updateAvailable.version }} ready to install
          </span>
        </div>
        <div class="flex items-center gap-2">
          <button
            class="btn-sm btn-primary"
            @click="installUpdate"
          >
            Restart Now
          </button>
          <button
            class="btn-sm btn-ghost"
            @click="dismiss"
          >
            Later
          </button>
        </div>
      </template>
    </div>
  </Transition>
</template>

<style scoped>
@reference "../../assets/styles/main.css";
.update-banner {
  @apply flex items-center justify-between gap-4 px-4 py-2;
  @apply bg-primary-50 dark:bg-primary-900/30;
  @apply border-b border-primary-200 dark:border-primary-800;
  @apply text-sm text-surface-700 dark:text-surface-200;
}

.btn-sm {
  @apply px-3 py-1 text-sm font-medium rounded-md transition-colors;
}

.btn-primary {
  @apply bg-primary-600 text-white hover:bg-primary-700;
}

.btn-ghost {
  @apply text-surface-600 dark:text-surface-400 hover:bg-surface-200 dark:hover:bg-surface-700;
}
</style>
