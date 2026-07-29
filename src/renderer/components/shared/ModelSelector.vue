<script setup lang="ts">
/**
 * Model selector dropdown component
 * Displays available Claude models and allows the user to switch between them
 */

import { ref, computed, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';

import { capitalizeFamily, familyKeyOf, isSameModel, parseModelId } from '@shared/model-id';
import type { ModelInfo } from '@shared/types';
import { useAsyncOperation } from '../../composables/useAsyncOperation';
import { useChatStore } from '../../stores/chat';
import { useConversationsStore } from '../../stores/conversations';
import { useSettingsStore } from '../../stores/settings';
import { logger } from '../../utils/logger';
import { formatModelId } from '../../utils/model';
import Icon from './Icon.vue';
import Modal from './Modal.vue';
import Spinner from './Spinner.vue';
import TransitionFade from './TransitionFade.vue';

const settingsStore = useSettingsStore();
const chatStore = useChatStore();
const conversationsStore = useConversationsStore();
const {
  selectedModel,
  thinkingMode,
  switchModelsOnFlag,
  strictModelEnforcement,
} = storeToRefs(settingsStore);

const models = ref<ModelInfo[]>([]);
const { isLoading, execute } = useAsyncOperation();
const isOpen = ref(false);
const dropdownRef = ref<HTMLDivElement | null>(null);

// The model Claude Code reports it is actually running. With no explicit
// selection the CLI picks for itself, so this is the only way to know what
// "Default" resolved to — and it also reveals a mid-session substitution.
const activeModel = ref<string>('');
let cleanupActiveModelListener: (() => void) | null = null;

// Confirmation dialog state
const showConfirmDialog = ref(false);
const pendingModelValue = ref<string | null>(null);

// Cleanup function for models listener
let cleanupModelsListener: (() => void) | null = null;

interface FamilyEntry {
  family: string;        // Human label, e.g. 'Opus'
  familyKey: string;     // Lower-case SDK key, e.g. 'opus'
  alias: ModelInfo | null;  // SDK family alias (e.g. value === 'opus'), if available
  versions: ModelInfo[]; // specific versioned models, sorted descending
}

// Known families get a fixed display order at the top of the menu; any new
// family the SDK reports lands after them in the order it first appears.
// Fable sits next to Opus because it is the tier above it.
const PREFERRED_FAMILY_ORDER: readonly string[] = ['opus', 'fable', 'sonnet', 'haiku'];

/**
 * The SDK returns family aliases (`default`, `opus`, `sonnet`, `haiku`, …)
 * along with specific versioned models (`claude-opus-5`, `claude-fable-5`,
 * `claude-opus-4-7`, `claude-sonnet-4-5-20250929`, …).
 *
 * Families are discovered from the model list itself — either an alias whose
 * value is a bare family name, or the first token of a `claude-<family>-…` ID.
 * We expose ONE top-level entry per family:
 *   - Click: selects the family alias (or latest version if alias unavailable)
 *   - Hover: reveals a submenu of specific versions
 */
const familyEntries = computed<FamilyEntry[]>(() => {
  const byFamily: Record<string, FamilyEntry> = {};
  // Track first-seen order for families not in PREFERRED_FAMILY_ORDER so the
  // menu is deterministic across renders.
  const encounterOrder: string[] = [];

  function ensureFamily(key: string): FamilyEntry {
    if (!byFamily[key]) {
      byFamily[key] = {
        family: capitalizeFamily(key),
        familyKey: key,
        alias: null,
        versions: [],
      };
      encounterOrder.push(key);
    }
    return byFamily[key];
  }

  for (const model of models.value) {
    // `default` is neither a family alias nor a versioned model; skip.
    if (model.value === 'default' || !model.value) continue;

    // supportedModels() returns three shapes and all of them appear in
    // practice: a bare alias ('sonnet'), an alias carrying a context-window
    // variant ('opus[1m]'), and a full model ID with or without one
    // ('claude-fable-5[1m]'). Splitting on "contains a hyphen" put `opus[1m]`
    // in a family of its own called "opus[1m]", which then sorted as an
    // unknown family instead of grouping under Opus.
    const family = familyKeyOf(model.value);
    if (!family) continue;

    // A row is a version row when it carries an actual version number;
    // otherwise it is the family's alias row.
    if (parseModelId(model.value)) {
      ensureFamily(family).versions.push(model);
    } else {
      ensureFamily(family).alias = model;
    }
  }

  const preferred = new Set(PREFERRED_FAMILY_ORDER);
  const ordered = [
    ...PREFERRED_FAMILY_ORDER.filter(k => byFamily[k]),
    ...encounterOrder.filter(k => !preferred.has(k)),
  ];

  return ordered
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

// Human label for whatever the CLI resolved, e.g. "Opus 5". Empty until an
// init message has been seen for this session.
const activeModelLabel = computed(() =>
  activeModel.value ? formatModelId(activeModel.value) : '',
);

// True when the running model is not the one that was selected. Covers a
// mid-session substitution (safety-classifier fallback, rate-limit fallback)
// as well as a resumed session that kept its original model.
const isModelMismatched = computed(() => {
  if (!selectedModel.value || !activeModel.value) return false;
  if (isSameModel(selectedModel.value, activeModel.value)) return false;
  // A family alias ('opus', 'opus[1m]') legitimately resolves to a concrete
  // ID. The SDK publishes that mapping on the alias row as `resolvedModel`;
  // fall back to comparing family keys when the row isn't loaded yet.
  const row = models.value.find(m => m.value === selectedModel.value);
  if (row?.resolvedModel && isSameModel(row.resolvedModel, activeModel.value)) return false;
  return familyKeyOf(activeModel.value) !== familyKeyOf(selectedModel.value);
});

// Current model display name. With no explicit selection, show what the CLI
// actually resolved rather than the word "Default", which tells the user
// nothing about which model is spending their tokens.
const currentModelDisplay = computed(() => {
  if (!selectedModel.value) {
    return activeModelLabel.value || 'Auto';
  }
  const model = models.value.find(m => m.value === selectedModel.value);
  return model?.displayName || formatModelId(selectedModel.value);
});

// Tooltip on the selector button — always states both sides when they differ.
const selectorTitle = computed(() => {
  if (!selectedModel.value) {
    return activeModelLabel.value
      ? `No model pinned — Claude Code chose ${activeModelLabel.value}`
      : 'No model pinned — Claude Code chooses';
  }
  if (isModelMismatched.value) {
    return `Selected ${formatModelId(selectedModel.value)}, but running ${activeModelLabel.value}`;
  }
  return 'Select AI model';
});

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

// Select a model. If an active session exists we confirm before switching —
// not because context is lost (the SDK uses Query.setModel() to swap in-place
// and preserves the transcript) but because billing/behavior of the next
// turn changes.
async function selectModel(modelValue: string): Promise<void> {
  isOpen.value = false;
  if (modelValue === selectedModel.value) return;

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

// User confirmed model change. The main process applies the new model to the
// existing session via Query.setModel() on the next message — context is
// preserved (see ClaudeCodeService.sendMessage). No session kill or
// --resume dance is needed.
async function confirmModelChange(): Promise<void> {
  showConfirmDialog.value = false;
  if (pendingModelValue.value === null) return;

  try {
    const displayName = getModelDisplayName(pendingModelValue.value);
    await applyModelChange(pendingModelValue.value);
    chatStore.addSystemMessage(`Model changed to ${displayName}`);
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

async function toggleSwitchModelsOnFlag(): Promise<void> {
  const enabled = !switchModelsOnFlag.value;
  await settingsStore.setSwitchModelsOnFlag(enabled);
  logger.info('Auto-switch on flag changed', { enabled });
  chatStore.addSystemMessage(
    enabled
      ? 'Claude Code may switch models when a message is flagged.'
      : 'Model switching disabled — a flagged message will pause the session instead. Applies to new sessions.',
  );
}

async function toggleStrictModelEnforcement(): Promise<void> {
  const enabled = !strictModelEnforcement.value;
  await settingsStore.setStrictModelEnforcement(enabled);
  logger.info('Strict model enforcement changed', { enabled });
  chatStore.addSystemMessage(
    enabled
      ? `Locked to ${currentModelDisplay.value}. Background agents cannot use another model. Applies to new sessions.`
      : 'Model lock removed — background agents may run the model named in their own definition.',
  );
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

  // Track the model the CLI reports it is actually running.
  cleanupActiveModelListener = window.electron.claude.onActiveModel((conversationId, model) => {
    if (conversationId !== conversationsStore.currentConversationId) return;
    activeModel.value = model;
    logger.info('Active model reported by CLI', { conversationId, model });
  });

  // Add click outside listener
  document.addEventListener('click', handleClickOutside);
});

onUnmounted(() => {
  if (cleanupModelsListener) {
    cleanupModelsListener();
  }
  if (cleanupActiveModelListener) {
    cleanupActiveModelListener();
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
      :title="selectorTitle"
      @click.stop="toggleDropdown"
    >
      <Icon
        name="cpu"
        size="sm"
        :class="isModelMismatched ? 'shrink-0 text-amber-500' : 'shrink-0'"
      />
      <span
        class="max-w-[100px] truncate"
        :class="{ 'text-amber-600 dark:text-amber-400': isModelMismatched }"
      >{{ currentModelDisplay }}</span>
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
                  No model pinned
                </div>
                <div class="text-xs text-surface-500 dark:text-surface-400 truncate">
                  {{
                    activeModelLabel
                      ? `Claude Code chose ${activeModelLabel}`
                      : 'Claude Code chooses — and may change it mid-session'
                  }}
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

        <!-- A model mismatch is explained by ModelMismatchBanner at the top of
             the window, which has room for a sentence. The picker shows only
             the compact amber tint on the button plus its tooltip. -->

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

        <!-- Allow Claude Code to swap models when a message is flagged.
             Mirrors the CLI's own switchModelsOnFlag setting. -->
        <button
          class="w-full px-3 py-2 text-left text-sm hover:bg-surface-50 dark:hover:bg-surface-700 transition-colors"
          @click.stop="toggleSwitchModelsOnFlag"
        >
          <div class="flex items-center gap-2">
            <span class="shrink-0 w-4 h-4 flex items-center justify-center">
              <Icon
                v-if="switchModelsOnFlag"
                name="check"
                size="sm"
                class="text-primary-500"
              />
            </span>
            <div class="flex-1 min-w-0">
              <div class="font-medium text-surface-800 dark:text-surface-200">
                Auto-switch when flagged
              </div>
              <div class="text-xs text-surface-500 dark:text-surface-400">
                {{
                  switchModelsOnFlag
                    ? 'On — switches model to keep going'
                    : 'Off — pauses instead of switching'
                }}
              </div>
            </div>
          </div>
        </button>

        <!-- Restrict the whole session, sub-agents included, to the selection. -->
        <button
          class="w-full px-3 py-2 text-left text-sm hover:bg-surface-50 dark:hover:bg-surface-700 transition-colors disabled:opacity-50"
          :disabled="!selectedModel"
          :title="!selectedModel ? 'Pin a model first' : ''"
          @click.stop="toggleStrictModelEnforcement"
        >
          <div class="flex items-center gap-2">
            <span class="shrink-0 w-4 h-4 flex items-center justify-center">
              <Icon
                v-if="strictModelEnforcement"
                name="check"
                size="sm"
                class="text-primary-500"
              />
            </span>
            <div class="flex-1 min-w-0">
              <div class="font-medium text-surface-800 dark:text-surface-200">
                Lock to this model
              </div>
              <div class="text-xs text-surface-500 dark:text-surface-400">
                {{
                  strictModelEnforcement
                    ? 'On — background agents forced onto it too'
                    : 'Off — agents may use their own model'
                }}
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
      aria-description="The new model will continue the same conversation with full prior context. Cost and behavior of the next turn will reflect the new model."
      @close="cancelModelChange"
    >
      <p class="text-sm text-surface-600 dark:text-surface-400">
        The new model will continue this conversation with full prior context — no session restart.
        Cost and behavior of the next turn will reflect the new model.
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
