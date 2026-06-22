<script setup lang="ts">
/**
 * Context Usage Bar - displays token usage, cost, and context remaining
 * Similar to how Claude Code CLI displays context occupation info
 */

import { computed } from 'vue';

import type { SessionUsage } from '@shared/types';

import { formatModelId } from '../../utils/model';
import Icon from '../shared/Icon.vue';

interface Props {
  /** Session usage data from the SDK */
  usage: SessionUsage | null;
}

const props = defineProps<Props>();

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
const primaryModel = computed(() => {
  if (!props.usage?.modelUsage) return null;
  const models = Object.keys(props.usage.modelUsage);
  if (models.length === 0) return null;
  return formatModelId(models[models.length - 1]);
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
          title="Primary model"
        >
          <span class="truncate max-w-[120px]">{{ primaryModel }}</span>
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
