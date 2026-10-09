<script setup lang="ts">
/**
 * Model selector dropdown component
 * Displays available Claude models and allows the user to switch between them
 */

import { ref, computed, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';

import {
  describeEffortLevel,
  EFFORT_LEVELS,
  effortLevelsFor,
  findModelRow,
  formatEffortLevel,
  resolveEffortForSelection,
} from '@shared/effort';
import { capitalizeFamily, familyKeyOf, isSameModel, parseModelId } from '@shared/model-id';
import type { EffortLevel, ModelInfo } from '@shared/types';
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
  effortLevel,
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
// Main-loop model, held in the chat store and registered once in
// useClaudeChat rather than each component opening its own IPC listener.
const { activeModel } = storeToRefs(chatStore);

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

/**
 * Which submenu is open (hover or focus).
 *
 * Keyed by a string so families are not the only thing that can have one:
 * reasoning effort and the session-behaviour toggles use the same mechanism,
 * which is what keeps them out of the top-level list. Family keys are
 * lower-case family names, so the sentinels below cannot collide with one.
 */
const openSubmenuKey = ref<string | null>(null);
let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null;

/** Submenu keys that are not model families. */
const EFFORT_SUBMENU = 'effort:levels';
const SESSION_SUBMENU = 'session:behaviour';

function openSubmenu(key: string): void {
  if (hoverCloseTimer) {
    clearTimeout(hoverCloseTimer);
    hoverCloseTimer = null;
  }
  openSubmenuKey.value = key;
}

function closeSubmenu(): void {
  hoverCloseTimer = setTimeout(() => {
    openSubmenuKey.value = null;
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
/**
 * Label for the selector chip, which has far less room than a menu row.
 *
 * Deliberately the short form — "Opus 5.5", not "Claude Opus 5.5". The chip
 * truncates, and the row's own displayName starts with "Claude", so the
 * version was the part that got cut: "Claude Opus 5.5" rendered as "Claude
 * Opus…" and hid the one thing the user had just chosen. Dropping the
 * redundant prefix keeps the version visible instead. Menu rows keep the full
 * name, and the tooltip carries the rest.
 */
const currentModelDisplay = computed(() => {
  if (!selectedModel.value) {
    return activeModelLabel.value || 'Auto';
  }
  // formatModelId yields "Opus 5.5" for a versioned ID and returns anything
  // it cannot parse unchanged, so fall back to the family for alias rows.
  if (parseModelId(selectedModel.value)) {
    return formatModelId(selectedModel.value);
  }
  const family = familyKeyOf(selectedModel.value);
  return family ? capitalizeFamily(family) : selectedModel.value;
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

/**
 * The model row the current selection refers to, whether the selection names
 * an alias ('opus[1m]') or the concrete version that alias resolves to.
 * Capability fields live on whichever row the SDK described.
 */
const selectedModelRow = computed<ModelInfo | undefined>(
  () => findModelRow(models.value, selectedModel.value),
);

/**
 * Effort levels offered for the current model, straight from what the SDK
 * reported for it. Empty hides the picker entirely rather than showing levels
 * the model would ignore.
 */
const availableEffortLevels = computed<EffortLevel[]>(() => {
  // With no explicit selection the CLI chooses the model, so there is no row
  // to read capabilities from. Offer the full set and let it downgrade.
  if (!selectedModel.value) return [...EFFORT_LEVELS];
  return effortLevelsFor(selectedModelRow.value);
});

/**
 * The level that will actually be sent — resolved through the same function
 * the main process uses, so the picker's check mark cannot disagree with what
 * the session runs at.
 */
const effectiveEffortLevel = computed<EffortLevel | null>(
  () => resolveEffortForSelection(effortLevel.value, selectedModel.value, models.value),
);

/**
 * What the collapsed "Reasoning effort" row says.
 *
 * Shows the level that will actually be sent, and names the requested one
 * when the model cannot honour it — otherwise the row would read "Max" on a
 * model running at High.
 */
const effortSummary = computed(() => {
  const effective = effectiveEffortLevel.value;
  if (!effective) return 'Not supported by this model';
  if (effective !== effortLevel.value) {
    return `${formatEffortLevel(effective)} — ${formatEffortLevel(effortLevel.value)} unavailable here`;
  }
  return formatEffortLevel(effective);
});

/**
 * What the collapsed "Session behaviour" row says: which of the two options
 * are on, so the state is visible without opening the submenu.
 */
const sessionBehaviourSummary = computed(() => {
  const on: string[] = [];
  if (switchModelsOnFlag.value) on.push('model fallback');
  if (strictModelEnforcement.value) on.push('single model');
  return on.length === 0 ? 'Both off' : `On: ${on.join(', ')}`;
});

async function selectEffortLevel(level: EffortLevel): Promise<void> {
  if (level === effortLevel.value) return;
  await settingsStore.setEffortLevel(level);
  logger.info('Effort level changed', { level });
}

async function toggleSwitchModelsOnFlag(): Promise<void> {
  const enabled = !switchModelsOnFlag.value;
  await settingsStore.setSwitchModelsOnFlag(enabled);
  logger.info('Auto-switch on flag changed', { enabled });
  chatStore.addSystemMessage(
    enabled
      ? 'If a safety check declines a message, Claude Code will continue on a different model. Applies to new sessions.'
      : 'If a safety check declines a message, the session will pause and tell you rather than switching model. Applies to new sessions.',
  );
}

async function toggleStrictModelEnforcement(): Promise<void> {
  const enabled = !strictModelEnforcement.value;
  await settingsStore.setStrictModelEnforcement(enabled);
  logger.info('Strict model enforcement changed', { enabled });
  chatStore.addSystemMessage(
    enabled
      ? `Everything now runs on ${currentModelDisplay.value} — background agents and housekeeping (titles, summaries, classifiers) included, which costs more than letting them use Haiku. Applies to new sessions.`
      : 'Background agents may again run the model named in their own definition, and Haiku handles housekeeping. Applies to new sessions.',
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
      :title="selectorTitle"
      @click.stop="toggleDropdown"
    >
      <Icon
        name="cpu"
        size="sm"
        :class="isModelMismatched ? 'shrink-0 text-amber-500' : 'shrink-0'"
      />
      <span
        class="max-w-[150px] truncate"
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
              v-if="openSubmenuKey === family.familyKey && family.versions.length > 0"
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

        <!-- Reasoning effort, as a submenu rather than five rows inline. The
             levels come from the SDK per model (supportedEffortLevels), never
             hardcoded, so the row is absent for a model that takes none. -->
        <div
          v-if="availableEffortLevels.length > 0"
          class="relative"
          @mouseenter="openSubmenu(EFFORT_SUBMENU)"
          @mouseleave="closeSubmenu()"
        >
          <button
            class="w-full px-3 py-2 text-left text-sm hover:bg-surface-50 dark:hover:bg-surface-700 transition-colors"
            @focus="openSubmenu(EFFORT_SUBMENU)"
            @blur="closeSubmenu()"
          >
            <div class="flex items-center gap-2">
              <span class="shrink-0 w-4 h-4" />
              <div class="flex-1 min-w-0">
                <div class="font-medium text-surface-800 dark:text-surface-200">
                  Reasoning effort
                </div>
                <div class="text-xs text-surface-500 dark:text-surface-400 truncate">
                  {{ effortSummary }}
                </div>
              </div>
              <Icon
                name="chevron-right"
                size="xs"
                class="shrink-0 opacity-60"
              />
            </div>
          </button>

          <div
            v-if="openSubmenuKey === EFFORT_SUBMENU"
            class="absolute right-full top-0 mr-1 z-50 min-w-[240px] max-w-[300px] rounded-lg shadow-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 py-1"
            @mouseenter="openSubmenu(EFFORT_SUBMENU)"
            @mouseleave="closeSubmenu()"
          >
            <div class="px-3 pt-1.5 pb-2 text-xs text-surface-500 dark:text-surface-400 border-b border-surface-200 dark:border-surface-700">
              How hard Claude thinks before answering. Higher is slower and
              costs more.
            </div>
            <button
              v-for="level in availableEffortLevels"
              :key="level"
              class="w-full px-3 py-2 text-left text-sm hover:bg-surface-50 dark:hover:bg-surface-700 transition-colors"
              :class="{ 'bg-primary-50 dark:bg-primary-900/20': level === effectiveEffortLevel }"
              @click.stop="selectEffortLevel(level)"
            >
              <div class="flex items-center gap-2">
                <span class="shrink-0 w-4 h-4 flex items-center justify-center">
                  <Icon
                    v-if="level === effectiveEffortLevel"
                    name="check"
                    size="sm"
                    class="text-primary-500"
                  />
                </span>
                <div class="flex-1 min-w-0">
                  <div class="font-medium text-surface-800 dark:text-surface-200">
                    {{ formatEffortLevel(level) }}
                  </div>
                  <div class="text-xs text-surface-500 dark:text-surface-400">
                    {{ describeEffortLevel(level) }}
                  </div>
                </div>
              </div>
            </button>
            <!-- The stored choice can outrank what this model accepts —
                 picking Max then switching to a model without it, say. Say so
                 rather than silently showing the check on a different row. -->
            <div
              v-if="effectiveEffortLevel && effectiveEffortLevel !== effortLevel"
              class="px-3 pt-1 pb-2 text-xs text-amber-600 dark:text-amber-400"
            >
              {{ formatEffortLevel(effortLevel) }} isn't available on this model —
              running at {{ formatEffortLevel(effectiveEffortLevel) }}.
            </div>
          </div>
        </div>

        <!-- Session behaviour, as its own submenu. These two are not model
             choices and sat in the middle of the model list looking like
             they were, with one-line labels that did not say what they do.
             Both only take effect on new sessions, which the old rows never
             mentioned. -->
        <div
          class="relative"
          @mouseenter="openSubmenu(SESSION_SUBMENU)"
          @mouseleave="closeSubmenu()"
        >
          <button
            class="w-full px-3 py-2 text-left text-sm hover:bg-surface-50 dark:hover:bg-surface-700 transition-colors"
            @focus="openSubmenu(SESSION_SUBMENU)"
            @blur="closeSubmenu()"
          >
            <div class="flex items-center gap-2">
              <span class="shrink-0 w-4 h-4" />
              <div class="flex-1 min-w-0">
                <div class="font-medium text-surface-800 dark:text-surface-200">
                  Session behaviour
                </div>
                <div class="text-xs text-surface-500 dark:text-surface-400 truncate">
                  {{ sessionBehaviourSummary }}
                </div>
              </div>
              <Icon
                name="chevron-right"
                size="xs"
                class="shrink-0 opacity-60"
              />
            </div>
          </button>

          <div
            v-if="openSubmenuKey === SESSION_SUBMENU"
            class="absolute right-full bottom-0 mr-1 z-50 min-w-[300px] max-w-[340px] rounded-lg shadow-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 py-1"
            @mouseenter="openSubmenu(SESSION_SUBMENU)"
            @mouseleave="closeSubmenu()"
          >
            <div class="px-3 pt-1.5 pb-2 text-xs text-surface-500 dark:text-surface-400 border-b border-surface-200 dark:border-surface-700">
              How a session handles models. Changes apply to new sessions, not
              the one already running.
            </div>

            <!-- switchModelsOnFlag. "Flagged" is the CLI's word for a safety
                 classifier declining a message; the old label assumed the
                 reader knew that. -->
            <button
              class="w-full px-3 py-2 text-left text-sm hover:bg-surface-50 dark:hover:bg-surface-700 transition-colors"
              @click.stop="toggleSwitchModelsOnFlag"
            >
              <div class="flex items-center gap-2">
                <span class="shrink-0 w-4 h-4 flex items-center justify-center mt-0.5">
                  <Icon
                    v-if="switchModelsOnFlag"
                    name="check"
                    size="sm"
                    class="text-primary-500"
                  />
                </span>
                <div class="flex-1 min-w-0">
                  <div class="font-medium text-surface-800 dark:text-surface-200">
                    Continue on another model if one declines
                  </div>
                  <div class="text-xs text-surface-500 dark:text-surface-400">
                    Claude's safety checks occasionally refuse a message.
                    {{
                      switchModelsOnFlag
                        ? 'Currently: Claude Code quietly continues on a different model.'
                        : 'Currently: the session pauses and tells you instead of switching.'
                    }}
                  </div>
                </div>
              </div>
            </button>

            <!-- strictModelEnforcement via the CLI's availableModels
                 allowlist. The cost consequence is the part users miss. -->
            <button
              class="w-full px-3 py-2 text-left text-sm hover:bg-surface-50 dark:hover:bg-surface-700 transition-colors disabled:opacity-50"
              :disabled="!selectedModel"
              :title="!selectedModel ? 'Pick a specific model first — there is nothing to restrict to while Claude Code chooses' : ''"
              @click.stop="toggleStrictModelEnforcement"
            >
              <div class="flex items-center gap-2">
                <span class="shrink-0 w-4 h-4 flex items-center justify-center mt-0.5">
                  <Icon
                    v-if="strictModelEnforcement"
                    name="check"
                    size="sm"
                    class="text-primary-500"
                  />
                </span>
                <div class="flex-1 min-w-0">
                  <div class="font-medium text-surface-800 dark:text-surface-200">
                    Use this model for everything
                  </div>
                  <div class="text-xs text-surface-500 dark:text-surface-400">
                    Background agents and housekeeping (titles, summaries,
                    classifiers) normally run on cheap Haiku.
                    {{
                      strictModelEnforcement
                        ? 'Currently: they are forced onto your chosen model, which costs more.'
                        : 'Currently: they use their own models, which is cheaper.'
                    }}
                  </div>
                </div>
              </div>
            </button>
          </div>
        </div>
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
