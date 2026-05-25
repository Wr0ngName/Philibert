<script setup lang="ts">
/**
 * Settings panel component with OAuth login support
 */

import type { ExecutionMode, LogLevel, UpdateChannel } from '@shared/types';
import { ref, computed, watch } from 'vue';
import { storeToRefs } from 'pinia';

import { useSettingsStore } from '../../stores/settings';
import Button from '../shared/Button.vue';
import Modal from '../shared/Modal.vue';
import AuthForm from '../shared/AuthForm.vue';

interface Props {
  open: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const settingsStore = useSettingsStore();
const { config, isSaving } = storeToRefs(settingsStore);

// Local form state
const localTheme = ref<'light' | 'dark' | 'system'>('system');
const localFontSize = ref(14);
const localLogLevel = ref<LogLevel>('info');
const localEnableNotifications = ref(true);
const localUpdateChannel = ref<UpdateChannel>('stable');
const localExecutionMode = ref<ExecutionMode>('sdk');
const authFormRef = ref<InstanceType<typeof AuthForm>>();

const isOAuthUser = computed(() =>
  authFormRef.value?.authStatus?.method === 'oauth' &&
  authFormRef.value?.authStatus?.isAuthenticated === true
);

// Log level options for the selector
const logLevelOptions: { value: LogLevel; label: string; description: string }[] = [
  { value: 'error', label: 'Error', description: 'Only errors' },
  { value: 'warn', label: 'Warning', description: 'Warnings and errors' },
  { value: 'info', label: 'Info', description: 'General information' },
  { value: 'debug', label: 'Debug', description: 'Detailed debugging' },
];

// Sync with store when modal opens
watch(
  () => config.value,
  (newConfig) => {
    localTheme.value = newConfig.theme;
    localFontSize.value = newConfig.fontSize;
    localLogLevel.value = newConfig.logLevel;
    localEnableNotifications.value = newConfig.enableNotifications;
    localUpdateChannel.value = newConfig.updateChannel;
    localExecutionMode.value = newConfig.executionMode;
  },
  { immediate: true }
);

// Refresh auth status when modal opens
watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      await authFormRef.value?.refreshAuthStatus();
      authFormRef.value?.resetState();
    }
  }
);

async function saveSettings() {
  // Save theme (also applies it), font size, and log level
  await settingsStore.setTheme(localTheme.value);
  await settingsStore.setFontSize(localFontSize.value);
  await settingsStore.setLogLevel(localLogLevel.value);
  await settingsStore.setEnableNotifications(localEnableNotifications.value);
  await settingsStore.setUpdateChannel(localUpdateChannel.value);
  const effectiveMode = config.value.authMethod === 'oauth' ? localExecutionMode.value : 'sdk';
  await settingsStore.setExecutionMode(effectiveMode);

  emit('close');
}

function cancel() {
  // Reset local state
  localTheme.value = config.value.theme;
  localFontSize.value = config.value.fontSize;
  localLogLevel.value = config.value.logLevel;
  localEnableNotifications.value = config.value.enableNotifications;
  localUpdateChannel.value = config.value.updateChannel;
  localExecutionMode.value = config.value.executionMode;
  authFormRef.value?.resetState();
  emit('close');
}
</script>

<template>
  <Modal
    :open="open"
    title="Settings"
    size="md"
    @close="cancel"
  >
    <div class="space-y-6">
      <!-- Authentication Section -->
      <AuthForm
        ref="authFormRef"
        :show-title="true"
      />

      <!-- Execution Mode (OAuth/Pro/Max users only) -->
      <div v-if="isOAuthUser">
        <label class="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
          Execution Mode
        </label>
        <div class="flex gap-2">
          <button
            :class="[
              'flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition-colors text-left',
              localExecutionMode === 'sdk'
                ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                : 'border-surface-300 dark:border-surface-600 text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700',
            ]"
            @click="localExecutionMode = 'sdk'"
          >
            <div class="font-medium">
              SDK
            </div>
            <div class="text-xs opacity-75">
              Credit pool billing, full features
            </div>
          </button>
          <button
            :class="[
              'flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition-colors text-left',
              localExecutionMode === 'channel'
                ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                : 'border-surface-300 dark:border-surface-600 text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700',
            ]"
            @click="localExecutionMode = 'channel'"
          >
            <div class="font-medium">
              Channel
            </div>
            <div class="text-xs opacity-75">
              Subscription billing, no credit cap
            </div>
          </button>
        </div>
        <div
          v-if="localExecutionMode === 'channel'"
          class="mt-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-200"
        >
          Channel mode uses your Pro/Max subscription for billing with no credit cap.
          Trade-offs: no real-time streaming (replies arrive complete), no mid-session model switching.
          Takes effect on the next new conversation.
        </div>
      </div>

      <!-- Theme -->
      <div>
        <label class="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
          Theme
        </label>
        <div class="flex gap-2">
          <button
            v-for="option in ['light', 'dark', 'system'] as const"
            :key="option"
            :class="[
              'flex-1 px-4 py-2 rounded-lg border text-sm font-medium capitalize transition-colors',
              localTheme === option
                ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                : 'border-surface-300 dark:border-surface-600 text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700',
            ]"
            @click="localTheme = option"
          >
            {{ option }}
          </button>
        </div>
      </div>

      <!-- Font Size -->
      <div>
        <label
          for="font-size"
          class="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2"
        >
          Font Size: {{ localFontSize }}px
        </label>
        <input
          id="font-size"
          v-model.number="localFontSize"
          type="range"
          min="12"
          max="20"
          step="1"
          class="w-full h-2 bg-surface-200 dark:bg-surface-700 rounded-lg appearance-none cursor-pointer"
        >
        <div class="flex justify-between text-xs text-surface-400 mt-1">
          <span>12px</span>
          <span>20px</span>
        </div>
      </div>

      <!-- Log Level -->
      <div>
        <label class="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
          Log Level
        </label>
        <div class="grid grid-cols-2 gap-2">
          <button
            v-for="option in logLevelOptions"
            :key="option.value"
            :class="[
              'px-3 py-2 rounded-lg border text-sm font-medium transition-colors text-left',
              localLogLevel === option.value
                ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                : 'border-surface-300 dark:border-surface-600 text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700',
            ]"
            @click="localLogLevel = option.value"
          >
            <div class="font-medium">
              {{ option.label }}
            </div>
            <div class="text-xs opacity-75">
              {{ option.description }}
            </div>
          </button>
        </div>
      </div>

      <!-- Notifications -->
      <div>
        <label class="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
          System Notifications
        </label>
        <div class="flex items-center justify-between p-3 rounded-lg border border-surface-300 dark:border-surface-600">
          <div class="flex-1">
            <div class="text-sm font-medium text-surface-700 dark:text-surface-300">
              Desktop Notifications
            </div>
            <div class="text-xs text-surface-500 dark:text-surface-400 mt-1">
              Show notifications when window is not focused
            </div>
          </div>
          <button
            :class="[
              'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
              localEnableNotifications
                ? 'bg-primary-600'
                : 'bg-surface-300 dark:bg-surface-600',
            ]"
            role="switch"
            :aria-checked="localEnableNotifications"
            aria-label="Toggle desktop notifications"
            @click="localEnableNotifications = !localEnableNotifications"
          >
            <span
              :class="[
                'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                localEnableNotifications ? 'translate-x-6' : 'translate-x-1',
              ]"
            />
          </button>
        </div>
      </div>

      <!-- Update Channel -->
      <div>
        <label class="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
          Update Channel
        </label>
        <div class="flex gap-2">
          <button
            :class="[
              'flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition-colors text-left',
              localUpdateChannel === 'stable'
                ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                : 'border-surface-300 dark:border-surface-600 text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700',
            ]"
            @click="localUpdateChannel = 'stable'"
          >
            <div class="font-medium">
              Stable
            </div>
            <div class="text-xs opacity-75">
              Production releases only
            </div>
          </button>
          <button
            :class="[
              'flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition-colors text-left',
              localUpdateChannel === 'rc'
                ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                : 'border-surface-300 dark:border-surface-600 text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700',
            ]"
            @click="localUpdateChannel = 'rc'"
          >
            <div class="font-medium">
              Release Candidate
            </div>
            <div class="text-xs opacity-75">
              Test upcoming versions early
            </div>
          </button>
        </div>
      </div>
    </div>

    <template #footer>
      <Button
        variant="ghost"
        @click="cancel"
      >
        Cancel
      </Button>
      <Button
        variant="primary"
        :loading="isSaving"
        @click="saveSettings"
      >
        Save Changes
      </Button>
    </template>
  </Modal>
</template>
