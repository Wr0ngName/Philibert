<script setup lang="ts">
/**
 * Model mismatch banner.
 *
 * Claude Code changes model on its own in several situations — a safety
 * classifier flagging a message, a rate-limit fallback, an unavailable model.
 * With no dialog host it does so without asking, and the swap persists for the
 * session, so the user has to be told.
 *
 * This lives at the top of the window rather than inside the model picker: the
 * picker is a narrow dropdown sized for one-line rows, and an explanation of
 * what happened does not belong there. The picker keeps only a compact amber
 * tint plus a tooltip; the explanation belongs in a banner with room for it.
 */

import { ref, computed, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';

import { familyKeyOf, isSameModel } from '@shared/model-id';
import type { ModelInfo } from '@shared/types';
import { useChatStore } from '../../stores/chat';
import { useSettingsStore } from '../../stores/settings';
import { formatModelId } from '../../utils/model';
import Icon from './Icon.vue';

const settingsStore = useSettingsStore();
const { selectedModel } = storeToRefs(settingsStore);
// Single source of truth for the main-loop model — registered once in
// useClaudeChat rather than each component opening its own IPC listener.
const { activeModel } = storeToRefs(useChatStore());

const models = ref<ModelInfo[]>([]);
/** Dismissal is keyed to the model pair, so a *different* swap re-announces. */
const dismissedFor = ref<string>('');

let cleanupModels: (() => void) | null = null;

const isMismatched = computed(() => {
  if (!selectedModel.value || !activeModel.value) return false;
  if (isSameModel(selectedModel.value, activeModel.value)) return false;
  // A family alias ('opus', 'opus[1m]') legitimately resolves to a concrete
  // ID; the SDK publishes that mapping on the alias row as `resolvedModel`.
  const row = models.value.find(m => m.value === selectedModel.value);
  if (row?.resolvedModel && isSameModel(row.resolvedModel, activeModel.value)) return false;
  return familyKeyOf(activeModel.value) !== familyKeyOf(selectedModel.value);
});

const pairKey = computed(() => `${selectedModel.value}->${activeModel.value}`);
const isVisible = computed(() => isMismatched.value && dismissedFor.value !== pairKey.value);

const selectedLabel = computed(() => {
  const row = models.value.find(m => m.value === selectedModel.value);
  return row?.displayName || formatModelId(selectedModel.value);
});
const runningLabel = computed(() => (activeModel.value ? formatModelId(activeModel.value) : ''));

function dismiss(): void {
  dismissedFor.value = pairKey.value;
}

/** Re-pin the session to the selected model by re-applying the selection. */
async function reapply(): Promise<void> {
  const target = selectedModel.value;
  if (!target) return;
  await settingsStore.setSelectedModel(target);
  dismiss();
}

onMounted(() => {
  cleanupModels = window.electron?.claude.onModelsChanged((newModels) => {
    models.value = newModels;
  }) ?? null;

  window.electron?.claude.getModels().then((loaded) => {
    models.value = loaded;
  }).catch(() => { /* picker surfaces load failures */ });
});

onUnmounted(() => {
  cleanupModels?.();
});
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
      v-if="isVisible"
      class="model-mismatch-banner"
    >
      <div class="flex items-center gap-2 min-w-0">
        <Icon
          name="warning"
          size="sm"
          class="shrink-0 text-amber-600 dark:text-amber-400"
        />
        <span class="truncate">
          Running <strong>{{ runningLabel }}</strong>, not
          <strong>{{ selectedLabel }}</strong>. Claude Code switches models on
          its own when a message is flagged or a model is unavailable.
        </span>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button
          class="btn-sm btn-amber"
          @click="reapply"
        >
          Use {{ selectedLabel }}
        </button>
        <button
          class="btn-sm btn-ghost"
          @click="dismiss"
        >
          Dismiss
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
@reference "../../assets/styles/main.css";
.model-mismatch-banner {
  @apply flex items-center justify-between gap-4 px-4 py-2;
  @apply bg-amber-50 dark:bg-amber-900/30;
  @apply border-b border-amber-200 dark:border-amber-800;
  @apply text-sm text-surface-700 dark:text-surface-200;
}

.btn-sm {
  @apply px-3 py-1 text-sm font-medium rounded-md transition-colors;
}

.btn-amber {
  @apply bg-amber-600 text-white hover:bg-amber-700;
}

.btn-ghost {
  @apply text-surface-600 dark:text-surface-400 hover:bg-surface-200 dark:hover:bg-surface-700;
}
</style>
