<script setup lang="ts">
/**
 * Context Usage Bar - displays token usage, cost, and context remaining
 * Similar to how Claude Code CLI displays context occupation info
 */

import { computed } from 'vue';
import { storeToRefs } from 'pinia';

import { isSameModel } from '@shared/model-id';
import { primaryModelId, secondaryModelIds } from '@shared/model-usage';
import type { SessionUsage } from '@shared/types';

import { useChatStore } from '../../stores/chat';
import { formatModelId } from '../../utils/model';
import Icon from '../shared/Icon.vue';

interface Props {
  /** Session usage data from the SDK */
  usage: SessionUsage | null;
}

const props = defineProps<Props>();

const { activeModel } = storeToRefs(useChatStore());

/**
 * Current context window occupation (tokens actually in the prompt).
 * Prefers SDK's getContextUsage() which gives the real number;
 * falls back to last-turn input tokens if not available.
 */
const totalTokensUsed = computed(() => {
  if (!props.usage) return 0;
  if (props.usage.contextTokens != null) return props.usage.contextTokens;
  return props.usage.usage.inputTokens + props.usage.usage.cacheReadInputTokens + props.usage.usage.outputTokens;
});

/**
 * Context window maximum size.
 * Prefers SDK's getContextUsage() maxTokens; falls back to modelUsage.
 */
const contextWindowSize = computed(() => {
  if (props.usage?.contextMaxTokens) return props.usage.contextMaxTokens;
  if (!props.usage?.modelUsage) return 0;
  const models = Object.values(props.usage.modelUsage);
  return models.length > 0 ? models[models.length - 1].contextWindow : 0;
});

/**
 * Calculate context usage percentage
 */
const contextUsagePercent = computed(() => {
  if (contextWindowSize.value === 0) return 0;
  return Math.min(100, (totalTokensUsed.value / contextWindowSize.value) * 100);
});

/**
 * Get color class based on usage percentage
 */
const usageColorClass = computed(() => {
  const percent = contextUsagePercent.value;
  if (percent >= 90) return 'bg-red-500';
  if (percent >= 75) return 'bg-yellow-500';
  if (percent >= 50) return 'bg-blue-500';
  return 'bg-green-500';
});

/**
 * Format token count for display
 */
function formatTokens(count: number): string {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return count.toString();
}

/**
 * Format cost for display
 */
function formatCost(cost: number): string {
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  return `$${cost.toFixed(2)}`;
}

/**
 * Model chip shown next to the usage bar. Reads the model the SDK reported
 * for the last turn (the authoritative "what actually ran" value) — used to
 * verify whether mid-session setModel() switches actually took effect.
 * The user's selected-for-next-turn model is already visible in the dropdown.
 */
/**
 * The discussion indicator shows the MAIN-LOOP model, which is what Claude
 * Code itself displays (getMainLoopModel -> getPublicModelDisplayName). It is
 * deliberately not derived from modelUsage: a turn's usage legitimately
 * includes the CLI's small-fast model doing titles and summaries, and a
 * background/utility turn can report Haiku usage alone — either way, reading
 * the model out of usage named Haiku on a conversation pinned to Opus.
 *
 * Falls back to the usage-derived model only when the CLI has not reported a
 * main-loop model yet (e.g. a restored conversation with no live session).
 */
const primaryModel = computed(() => {
  const id = activeModel.value || primaryModelId(props.usage?.modelUsage);
  return id ? formatModelId(id) : null;
});

/**
 * Models that ran alongside the primary one — Claude Code's small-fast model
 * doing titles/summaries/classifiers, which is billed and reported but never
 * answered the user. Shown in the tooltip so utility usage stays visible
 * without it being mistaken for the conversation's model.
 */
const secondaryModels = computed(() => {
  const ids = activeModel.value
    // Everything that ran besides the main-loop model — the small-fast model
    // doing internal work, and any sub-agent on a different model.
    ? Object.keys(props.usage?.modelUsage ?? {}).filter(
      (id) => !isSameModel(id, activeModel.value as string),
    )
    : secondaryModelIds(props.usage?.modelUsage);
  return ids.map(formatModelId);
});

const modelChipTitle = computed(() => {
  if (!primaryModel.value) return '';
  return secondaryModels.value.length > 0
    ? `Conversation model: ${primaryModel.value}. Also billed this session: ${secondaryModels.value.join(', ')} (internal tasks and sub-agents).`
    : `Conversation model: ${primaryModel.value}`;
});
</script>

<template>
  <div
    v-if="usage"
    class="context-usage-bar"
  >
    <!-- Progress bar -->
    <div class="flex items-center gap-3">
      <div class="flex-1 h-1.5 bg-surface-200 dark:bg-surface-700 rounded-full overflow-hidden">
        <div
          :class="[usageColorClass, 'h-full rounded-full transition-all duration-300']"
          :style="{ width: `${contextUsagePercent}%` }"
        />
      </div>
      <span class="text-xs text-surface-500 dark:text-surface-400 whitespace-nowrap">
        {{ contextUsagePercent.toFixed(0) }}%
      </span>
    </div>

    <!-- Stats row -->
    <div class="flex items-center justify-between mt-1.5 text-xs text-surface-500 dark:text-surface-400">
      <div class="flex items-center gap-3">
        <!-- Tokens -->
        <div
          class="flex items-center gap-1"
          title="Total tokens used (input + output)"
        >
          <Icon
            name="terminal"
            size="xs"
          />
          <span>{{ formatTokens(totalTokensUsed) }}</span>
          <span
            v-if="contextWindowSize > 0"
            class="text-surface-400 dark:text-surface-500"
          >
            / {{ formatTokens(contextWindowSize) }}
          </span>
        </div>

        <!-- Input/Output breakdown -->
        <div
          v-if="usage.usage.inputTokens > 0 || usage.usage.outputTokens > 0"
          class="hidden sm:flex items-center gap-1 text-surface-400 dark:text-surface-500"
        >
          <span title="Input tokens">{{ formatTokens(usage.usage.inputTokens) }} in</span>
          <span>/</span>
          <span title="Output tokens">{{ formatTokens(usage.usage.outputTokens) }} out</span>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <!-- Cost -->
        <div
          v-if="usage.totalCostUSD > 0"
          class="flex items-center gap-1"
          title="Session cost"
        >
          <Icon
            name="info"
            size="xs"
          />
          <span>{{ formatCost(usage.totalCostUSD) }}</span>
        </div>

        <!-- Model -->
        <div
          v-if="primaryModel"
          class="hidden md:flex items-center gap-1 text-surface-400 dark:text-surface-500"
          :title="modelChipTitle"
        >
          <span class="truncate max-w-[120px]">{{ primaryModel }}</span>
          <span
            v-if="secondaryModels.length > 0"
            class="opacity-60"
          >+{{ secondaryModels.length }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "../../assets/styles/main.css";
.context-usage-bar {
  @apply px-3 py-2 bg-surface-50 dark:bg-surface-800 border-t border-surface-200 dark:border-surface-700;
}
</style>
