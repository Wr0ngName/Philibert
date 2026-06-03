<script setup lang="ts">
/**
 * Model selector dropdown component
 * Displays available Claude models and allows the user to switch between them
 */

import { ref, computed, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';

import type { ModelInfo } from '@shared/types';
import { useAsyncOperation } from '../../composables/useAsyncOperation';
import { useChatStore } from '../../stores/chat';
import { useConversationsStore } from '../../stores/conversations';
import { useSettingsStore } from '../../stores/settings';
import { logger } from '../../utils/logger';
import Icon from './Icon.vue';
import Modal from './Modal.vue';
import Spinner from './Spinner.vue';
import TransitionFade from './TransitionFade.vue';

const settingsStore = useSettingsStore();
const chatStore = useChatStore();
const conversationsStore = useConversationsStore();
const { selectedModel, thinkingMode } = storeToRefs(settingsStore);

const models = ref<ModelInfo[]>([]);
const { isLoading, execute } = useAsyncOperation();
const isOpen = ref(false);
const dropdownRef = ref<HTMLDivElement | null>(null);

// Confirmation dialog state
const showConfirmDialog = ref(false);
const pendingModelValue = ref<string | null>(null);

// Cleanup function for models listener
let cleanupModelsListener: (() => void) | null = null;

interface FamilyEntry {
  family: string;        // 'Opus', 'Sonnet', 'Haiku'
  familyKey: string;     // 'opus', 'sonnet', 'haiku'
  alias: ModelInfo | null;  // SDK family alias (e.g. value === 'opus'), if available
  versions: ModelInfo[]; // specific versioned models, sorted descending
}

const FAMILY_ORDER = ['opus', 'sonnet', 'haiku'] as const;
const FAMILY_LABELS: Record<string, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
};

/**
 * The SDK returns family aliases (`default`, `opus`, `sonnet`, `haiku`) that
 * resolve to the recommended model for each family server-side, along with
 * specific versioned models (`claude-opus-4-7`, `claude-sonnet-4-5-20250929`).
 *
 * We expose ONE top-level entry per family:
 *   - Click: selects the family alias (or latest version if alias unavailable)
 *   - Hover: reveals a submenu of specific versions
 */
const familyEntries = computed<FamilyEntry[]>(() => {
  const byFamily: Record<string, FamilyEntry> = {};
  for (const key of FAMILY_ORDER) {
    byFamily[key] = {
      family: FAMILY_LABELS[key],
      familyKey: key,
      alias: null,
      versions: [],
    };
  }

  for (const model of models.value) {
    if (FAMILY_ORDER.includes(model.value as typeof FAMILY_ORDER[number])) {
      byFamily[model.value].alias = model;
      continue;
    }
    const match = model.value.match(/^claude-(opus|sonnet|haiku)-\d+-\d+/);
    if (match) {
      byFamily[match[1]].versions.push(model);
    }
  }

  return FAMILY_ORDER
    .map(k => byFamily[k])
    .filter(f => f.alias || f.versions.length > 0);
});

// Which family's submenu is currently open (hover or focus)
const hoveredFamily = ref<string | null>(null);
let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null;

function openSubmenu(familyKey: string): void {
  if (hoverCloseTimer) {
    clearTimeout(hoverCloseTimer);
    hoverCloseTimer = null;
  }
  hoveredFamily.value = familyKey;
}

function closeSubmenu(): void {
  hoverCloseTimer = setTimeout(() => {
    hoveredFamily.value = null;
  }, 150);
}

function familyTargetValue(family: FamilyEntry): string {
  return family.alias?.value ?? family.versions[0]?.value ?? '';
}

function familyDescription(family: FamilyEntry): string {
  return family.alias?.description ?? family.versions[0]?.description ?? '';
}

function isFamilySelected(family: FamilyEntry): boolean {
  if (!selectedModel.value) return false;
  if (family.alias && family.alias.value === selectedModel.value) return true;
  return family.versions.some(v => v.value === selectedModel.value);
}

function selectFamily(family: FamilyEntry): void {
  const target = familyTargetValue(family);
  if (target) selectModel(target);
}

// Current model display name
const currentModelDisplay = computed(() => {
  if (!selectedModel.value) {
    return 'Default';
  }
  const model = models.value.find(m => m.value === selectedModel.value);
  return model?.displayName || formatModelId(selectedModel.value);
});

// Format model ID for display if no display name available
function formatModelId(modelId: string): string {
  // Extract the model family from the ID (e.g., "claude-sonnet-4-5-20250929" -> "Sonnet 4.5")
  const match = modelId.match(/claude-(\w+)-(\d+)-?(\d+)?/);
  if (match) {
    const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
    return `${family} ${version}`;
  }
  return modelId;
}

// Load available models
async function loadModels(): Promise<void> {
  await execute(async () => {
    const loadedModels = await window.electron.claude.getModels();
    models.value = loadedModels;
    logger.debug('Loaded models', { count: loadedModels.length });
  }, 'Failed to load models');
}

// Apply model change (shared by direct selection and confirmation)
async function applyModelChange(modelValue: string): Promise<void> {
  await settingsStore.setSelectedModel(modelValue);
  logger.info('Model changed', { model: modelValue || '(default)' });
}

// Select a model - may require confirmation if conversation has an active session
async function selectModel(modelValue: string): Promise<void> {
  isOpen.value = false;
  if (modelValue === selectedModel.value) return;

  // If the current conversation has an active SDK session, changing the model
  // requires starting a fresh session (the CLI ignores --model during --resume).
  // Warn the user that Claude will lose context of previous messages.
  if (conversationsStore.currentConversationHasSession()) {
    pendingModelValue.value = modelValue;
    showConfirmDialog.value = true;
    return;
  }

  try {
    await applyModelChange(modelValue);
  } catch (err) {
    logger.error('Failed to change model', err);
  }
}

// Format a model value for display in the system message
function getModelDisplayName(modelValue: string): string {
  if (!modelValue) return 'Default';
  const model = models.value.find(m => m.value === modelValue);
  return model?.displayName || formatModelId(modelValue);
}

// User confirmed model change - kill active session and apply new model
async function confirmModelChange(): Promise<void> {
  showConfirmDialog.value = false;
  if (pendingModelValue.value === null) return;

  try {
    const displayName = getModelDisplayName(pendingModelValue.value);
    const currentConvId = conversationsStore.currentConversationId;

    // Abort the active SDK session on the main process so the next message
    // creates a fresh session with the newly selected model
    if (currentConvId) {
      await window.electron.claude.abort(currentConvId);
    }

    conversationsStore.clearCurrentSdkSessionId();
    await applyModelChange(pendingModelValue.value);
    chatStore.addSystemMessage(`Model changed to ${displayName} — new session started`);
  } catch (err) {
    logger.error('Failed to change model', err);
  } finally {
    pendingModelValue.value = null;
  }
}

// User cancelled model change
function cancelModelChange(): void {
  showConfirmDialog.value = false;
  pendingModelValue.value = null;
}

async function toggleThinking(): Promise<void> {
  const newMode = thinkingMode.value === 'auto' ? 'disabled' : 'auto';
  await settingsStore.setThinkingMode(newMode);
  logger.info('Thinking mode changed', { mode: newMode });
}

// Toggle dropdown
function toggleDropdown(): void {
  isOpen.value = !isOpen.value;
  // Load models when opening if not yet loaded
  if (isOpen.value && models.value.length === 0) {
    loadModels();
  }
}

// Close dropdown when clicking outside
function handleClickOutside(event: MouseEvent): void {
  if (dropdownRef.value && !dropdownRef.value.contains(event.target as Node)) {
    isOpen.value = false;
  }
}

onMounted(() => {
  // Load models initially
  loadModels();

  // Listen for model updates from the SDK
  cleanupModelsListener = window.electron.claude.onModelsChanged((newModels) => {
    models.value = newModels;
    logger.debug('Models updated from SDK', { count: newModels.length });
  });

  // Add click outside listener
  document.addEventListener('click', handleClickOutside);
});

onUnmounted(() => {
  if (cleanupModelsListener) {
    cleanupModelsListener();
  }
  document.removeEventListener('click', handleClickOutside);
});
</script>

<template>
  <div
    ref="dropdownRef"
    class="relative"
  >
    <!-- Selector Button -->
    <button
      class="flex items-center gap-1.5 px-2 py-1 text-sm rounded-md hover:bg-surface-100 dark:hover:bg-surface-700 text-surface-600 dark:text-surface-400 transition-colors"
      :class="{ 'bg-surface-100 dark:bg-surface-700': isOpen }"
      title="Select AI model"
      @click.stop="toggleDropdown"
    >
      <Icon
        name="cpu"
        size="sm"
        class="shrink-0"
      />
      <span class="max-w-[100px] truncate">{{ currentModelDisplay }}</span>
      <Icon
        :name="isOpen ? 'chevron-up' : 'chevron-down'"
        size="xs"
        class="shrink-0 opacity-60"
      />
    </button>

    <!-- Dropdown Menu -->
    <TransitionFade type="scale">
      <div
        v-if="isOpen"
        class="absolute right-0 top-full mt-1 z-50 min-w-[200px] max-w-[280px] rounded-lg shadow-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 py-1"
      >
        <!-- Loading state -->
        <div
          v-if="isLoading"
          class="flex items-center justify-center py-4"
        >
          <Spinner size="sm" />
        </div>

        <!-- Empty state -->
        <div
          v-else-if="models.length === 0"
          class="px-3 py-2 text-sm text-surface-500 dark:text-surface-400 text-center"
        >
          <p>No models available</p>
          <p class="text-xs mt-1">
            Start a conversation to load models
          </p>
        </div>

        <!-- Model list -->
        <template v-else>
          <!-- Default option (no model override — SDK picks) -->
          <button
            class="w-full px-3 py-2 text-left text-sm hover:bg-surface-50 dark:hover:bg-surface-700 transition-colors"
            :class="{ 'bg-primary-50 dark:bg-primary-900/20': !selectedModel }"
            @click="selectModel('')"
          >
            <div class="flex items-center gap-2">
              <span
                class="shrink-0 w-4 h-4 flex items-center justify-center"
              >
                <Icon
                  v-if="!selectedModel"
                  name="check"
                  size="sm"
                  class="text-primary-500"
                />
              </span>
              <div class="flex-1 min-w-0">
                <div class="font-medium text-surface-800 dark:text-surface-200">
                  Default
                </div>
                <div class="text-xs text-surface-500 dark:text-surface-400 truncate">
                  Let the SDK pick the best model
                </div>
              </div>
            </div>
          </button>

          <div class="h-px bg-surface-200 dark:bg-surface-700 my-1" />

          <!-- Family entries: click to select family default, hover to reveal versions -->
          <div
            v-for="family in familyEntries"
            :key="family.familyKey"
            class="relative"
            @mouseenter="openSubmenu(family.familyKey)"
            @mouseleave="closeSubmenu()"
          >
            <button
              class="w-full px-3 py-2 text-left text-sm hover:bg-surface-50 dark:hover:bg-surface-700 transition-colors"
              :class="{ 'bg-primary-50 dark:bg-primary-900/20': isFamilySelected(family) }"
              @click="selectFamily(family)"
              @focus="openSubmenu(family.familyKey)"
              @blur="closeSubmenu()"
            >
              <div class="flex items-center gap-2">
                <span
                  class="shrink-0 w-4 h-4 flex items-center justify-center"
                >
                  <Icon
                    v-if="isFamilySelected(family)"
                    name="check"
                    size="sm"
                    class="text-primary-500"
                  />
                </span>
                <div class="flex-1 min-w-0">
                  <div class="font-medium text-surface-800 dark:text-surface-200">
                    {{ family.family }}
                  </div>
                  <div
                    v-if="familyDescription(family)"
                    class="text-xs text-surface-500 dark:text-surface-400 truncate"
                  >
                    {{ familyDescription(family) }}
                  </div>
                </div>
                <Icon
                  v-if="family.versions.length > 0"
                  name="chevron-right"
                  size="xs"
                  class="shrink-0 opacity-60"
                />
              </div>
            </button>

            <!-- Submenu: specific versions for this family -->
            <div
              v-if="hoveredFamily === family.familyKey && family.versions.length > 0"
              class="absolute right-full top-0 mr-1 z-50 min-w-[220px] max-w-[280px] rounded-lg shadow-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 py-1"
              @mouseenter="openSubmenu(family.familyKey)"
              @mouseleave="closeSubmenu()"
            >
              <button
                v-for="version in family.versions"
                :key="version.value"
                class="w-full px-3 py-2 text-left text-sm hover:bg-surface-50 dark:hover:bg-surface-700 transition-colors"
                :class="{ 'bg-primary-50 dark:bg-primary-900/20': selectedModel === version.value }"
                @click="selectModel(version.value)"
              >
                <div class="flex items-center gap-2">
                  <span
                    class="shrink-0 w-4 h-4 flex items-center justify-center"
                  >
                    <Icon
                      v-if="selectedModel === version.value"
                      name="check"
                      size="sm"
                      class="text-primary-500"
                    />
                  </span>
                  <div class="flex-1 min-w-0">
                    <div class="font-medium text-surface-800 dark:text-surface-200">
                      {{ version.displayName }}
                    </div>
                    <div
                      v-if="version.description"
                      class="text-xs text-surface-500 dark:text-surface-400 truncate"
                    >
                      {{ version.description }}
                    </div>
                  </div>
                </div>
              </button>
            </div>
          </div>
        </template>

        <!-- Model options separator -->
        <div class="h-px bg-surface-200 dark:bg-surface-700 my-1" />

        <!-- Extended Thinking toggle -->
        <button
          class="w-full px-3 py-2 text-left text-sm hover:bg-surface-50 dark:hover:bg-surface-700 transition-colors"
          @click.stop="toggleThinking"
        >
          <div class="flex items-center gap-2">
            <span class="shrink-0 w-4 h-4 flex items-center justify-center">
              <Icon
                v-if="thinkingMode === 'auto'"
                name="check"
                size="sm"
                class="text-primary-500"
              />
            </span>
            <div class="flex-1 min-w-0">
              <div class="font-medium text-surface-800 dark:text-surface-200">
                Extended Thinking
              </div>
              <div class="text-xs text-surface-500 dark:text-surface-400">
                {{ thinkingMode === 'auto' ? 'Auto — Claude decides when to think' : 'Disabled — saves tokens' }}
              </div>
            </div>
          </div>
        </button>
      </div>
    </TransitionFade>

    <!-- Confirmation dialog for model change mid-conversation -->
    <Modal
      :open="showConfirmDialog"
      title="Change model?"
      size="sm"
      aria-description="Changing the model will start a fresh session. Claude will not have context of previous messages."
      @close="cancelModelChange"
    >
      <p class="text-sm text-surface-600 dark:text-surface-400">
        Changing the model requires starting a fresh session. Claude will not have context of previous messages in this conversation.
      </p>

      <template #footer>
        <button
          class="px-4 py-2 text-sm rounded-lg border border-surface-300 dark:border-surface-600 text-surface-700 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-700 transition-colors"
          @click="cancelModelChange"
        >
          Cancel
        </button>
        <button
          class="px-4 py-2 text-sm rounded-lg bg-primary-500 text-white hover:bg-primary-600 transition-colors"
          @click="confirmModelChange"
        >
          Change model
        </button>
      </template>
    </Modal>
  </div>
</template>
