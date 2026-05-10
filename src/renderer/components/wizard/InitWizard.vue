<script setup lang="ts">
/**
 * Initial setup wizard for first-time users.
 * Guides through folder selection and authentication setup.
 */

import { ref, computed, onMounted } from 'vue';

import Button from '../shared/Button.vue';
import AuthForm from '../shared/AuthForm.vue';
import Icon from '../shared/Icon.vue';
import { useAuthentication } from '../../composables/useAuthentication';
import { logger } from '../../utils/logger';

const emit = defineEmits<{
  (e: 'complete'): void;
}>();

// Wizard state
const currentStep = ref(1);
const totalSteps = 3;

// Step 1: Welcome (no state needed)

// Step 2: Folder selection
const selectedFolder = ref('');
const isSelectingFolder = ref(false);

// Step 3: Authentication
const authFormRef = ref<InstanceType<typeof AuthForm>>();
const { authStatus, refreshAuthStatus, resetState } = useAuthentication();

// Computed
const canProceed = computed(() => {
  switch (currentStep.value) {
    case 1:
      return true; // Welcome step, always can proceed
    case 2:
      return !!selectedFolder.value;
    case 3:
      return authStatus.value.isAuthenticated;
    default:
      return false;
  }
});

const stepTitle = computed(() => {
  switch (currentStep.value) {
    case 1:
      return 'Welcome to Philibert';
    case 2:
      return 'Choose Your Project';
    case 3:
      return 'Connect Your Account';
    default:
      return '';
  }
});

const stepDescription = computed(() => {
  switch (currentStep.value) {
    case 1:
      return 'Your AI-powered coding assistant. Let\'s get you set up in just a few steps.';
    case 2:
      return 'Select the folder where your project lives. Claude will help you work with files in this directory.';
    case 3:
      return 'Login with your Claude account to start chatting with your AI assistant.';
    default:
      return '';
  }
});

// Methods
async function selectFolder() {
  isSelectingFolder.value = true;
  try {
    const folder = await window.electron.files.selectDirectory();
    if (folder) {
      selectedFolder.value = folder;
    }
  } catch (err) {
    logger.error('Failed to select folder', err);
  } finally {
    isSelectingFolder.value = false;
  }
}

function nextStep() {
  if (currentStep.value < totalSteps) {
    currentStep.value++;
  }
}

function prevStep() {
  if (currentStep.value > 1) {
    currentStep.value--;
    // Reset auth state when going back
    if (currentStep.value === 2) {
      resetState();
    }
  }
}

async function finishWizard() {
  // Save the selected folder
  if (selectedFolder.value) {
    await window.electron.config.set({
      workingDirectory: selectedFolder.value,
    });
  }
  emit('complete');
}

function skipAuth() {
  // Allow skipping auth step but still save folder
  finishWizard();
}

/**
 * Handle successful authentication from AuthForm
 */
async function onAuthenticated() {
  // Refresh our auth status to update canProceed
  await refreshAuthStatus();
}

// Window controls
const isMac = window.electron?.platform === 'darwin';

function minimize() {
  window.electron?.window.minimize();
}

function maximize() {
  window.electron?.window.maximize();
}

function close() {
  window.electron?.window.close();
}

// Initialize
onMounted(() => {
  refreshAuthStatus();
});
</script>

<template>
  <div class="fixed inset-0 bg-surface-900/90 flex flex-col z-50">
    <!-- Title bar with drag region and window controls -->
    <div class="h-10 w-full drag-region flex-shrink-0 flex items-center justify-end px-2">
      <!-- Window controls (non-macOS) - white icons for dark background -->
      <div
        v-if="!isMac"
        class="flex items-center no-drag"
      >
        <button
          class="w-10 h-8 flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors"
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
          class="w-10 h-8 flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors"
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
          class="w-10 h-8 flex items-center justify-center text-white/70 hover:text-white hover:bg-red-500 transition-colors"
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
    </div>

    <!-- Wizard content centered below drag region -->
    <div class="flex-1 flex items-center justify-center overflow-auto">
      <div class="bg-white dark:bg-surface-800 rounded-2xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden my-4">
      <!-- Progress bar -->
      <div class="h-1 bg-surface-200 dark:bg-surface-700">
        <div
          class="h-full bg-primary-500 transition-all duration-300"
          :style="{ width: `${(currentStep / totalSteps) * 100}%` }"
        />
      </div>

      <!-- Content -->
      <div class="p-8">
        <!-- Step indicator -->
        <div class="flex items-center justify-center gap-2 mb-6">
          <template
            v-for="step in totalSteps"
            :key="step"
          >
            <div
              :class="[
                'w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors',
                step === currentStep
                  ? 'bg-primary-500 text-white'
                  : step < currentStep
                    ? 'bg-primary-100 dark:bg-primary-900 text-primary-600 dark:text-primary-400'
                    : 'bg-surface-200 dark:bg-surface-700 text-surface-500',
              ]"
            >
              <Icon
                v-if="step < currentStep"
                name="check"
                size="sm"
              />
              <span v-else>{{ step }}</span>
            </div>
            <div
              v-if="step < totalSteps"
              :class="[
                'w-12 h-0.5 transition-colors',
                step < currentStep ? 'bg-primary-500' : 'bg-surface-200 dark:bg-surface-700',
              ]"
            />
          </template>
        </div>

        <!-- Step title -->
        <h2 class="text-2xl font-bold text-center text-surface-900 dark:text-white mb-2">
          {{ stepTitle }}
        </h2>
        <p class="text-center text-surface-600 dark:text-surface-400 mb-8">
          {{ stepDescription }}
        </p>

        <!-- Step 1: Welcome -->
        <div
          v-if="currentStep === 1"
          class="text-center"
        >
          <div class="w-24 h-24 mx-auto mb-6 rounded-2xl bg-primary-500 flex items-center justify-center">
            <Icon
              name="terminal"
              size="xl"
              class="text-white"
            />
          </div>
          <div class="space-y-4 text-left max-w-md mx-auto">
            <div class="flex items-start gap-3">
              <div class="w-6 h-6 rounded-full bg-primary-100 dark:bg-primary-900 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Icon
                  name="check"
                  size="xs"
                  class="text-primary-600 dark:text-primary-400"
                />
              </div>
              <p class="text-surface-700 dark:text-surface-300">
                <strong>Write & edit code</strong> with AI assistance
              </p>
            </div>
            <div class="flex items-start gap-3">
              <div class="w-6 h-6 rounded-full bg-primary-100 dark:bg-primary-900 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Icon
                  name="check"
                  size="xs"
                  class="text-primary-600 dark:text-primary-400"
                />
              </div>
              <p class="text-surface-700 dark:text-surface-300">
                <strong>Run commands</strong> directly from the chat
              </p>
            </div>
            <div class="flex items-start gap-3">
              <div class="w-6 h-6 rounded-full bg-primary-100 dark:bg-primary-900 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Icon
                  name="check"
                  size="xs"
                  class="text-primary-600 dark:text-primary-400"
                />
              </div>
              <p class="text-surface-700 dark:text-surface-300">
                <strong>Review changes</strong> before they're applied
              </p>
            </div>
          </div>
        </div>

        <!-- Step 2: Folder Selection -->
        <div
          v-else-if="currentStep === 2"
          class="text-center"
        >
          <div
            v-if="selectedFolder"
            class="p-4 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 mb-6"
          >
            <div class="flex items-center justify-center gap-3">
              <Icon
                name="folder"
                size="md"
                class="text-green-500"
              />
              <span class="font-mono text-sm text-green-800 dark:text-green-200 truncate max-w-md">
                {{ selectedFolder }}
              </span>
            </div>
          </div>

          <Button
            variant="primary"
            size="lg"
            :loading="isSelectingFolder"
            class="mx-auto"
            @click="selectFolder"
          >
            <Icon
              name="folder"
              size="md"
              class="mr-2"
            />
            {{ selectedFolder ? 'Change Folder' : 'Select Folder' }}
          </Button>

          <p class="mt-4 text-sm text-surface-500 dark:text-surface-400">
            You can change this later in Settings
          </p>
        </div>

        <!-- Step 3: Authentication -->
        <div
          v-else-if="currentStep === 3"
          class="max-w-md mx-auto"
        >
          <AuthForm
            ref="authFormRef"
            :show-title="false"
            @authenticated="onAuthenticated"
          />
        </div>
      </div>

      <!-- Footer -->
      <div class="px-8 py-4 bg-surface-50 dark:bg-surface-900 border-t border-surface-200 dark:border-surface-700 flex items-center justify-between">
        <Button
          v-if="currentStep > 1"
          variant="ghost"
          @click="prevStep"
        >
          <Icon
            name="chevron-left"
            size="sm"
            class="mr-1"
          />
          Back
        </Button>
        <div
          v-else
          class="w-20"
        />

        <div class="flex items-center gap-3">
          <Button
            v-if="currentStep === 3 && !authStatus.isAuthenticated"
            variant="ghost"
            @click="skipAuth"
          >
            Skip for now
          </Button>

          <Button
            v-if="currentStep < totalSteps"
            variant="primary"
            :disabled="!canProceed"
            @click="nextStep"
          >
            Continue
            <Icon
              name="chevron-right"
              size="sm"
              class="ml-1"
            />
          </Button>

          <Button
            v-else
            variant="primary"
            :disabled="!authStatus.isAuthenticated"
            @click="finishWizard"
          >
            Get Started
            <Icon
              name="arrow-right"
              size="sm"
              class="ml-1"
            />
          </Button>
        </div>
      </div>
    </div>
    </div>
  </div>
</template>
