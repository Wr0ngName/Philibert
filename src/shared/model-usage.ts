/**
 * Picking the model a turn actually ran on, out of the per-model usage map.
 *
 * `modelUsage` is a breakdown keyed by model, and a single turn routinely
 * touches more than one. Claude Code resolves a dedicated "small fast model"
 * separately from the main loop model (`getSmallFastModel` vs
 * `getMainLoopModel` in the CLI) and uses it for internal work — titles,
 * summaries, classifiers. That work is billed and reported alongside the
 * model that answered the user, so a turn answered by Opus commonly reports
 * both `claude-opus-*` and `claude-haiku-*`.
 *
 * Reading "the last key" out of that map — which is what the usage bar and
 * the context-window calculation both did — picks whichever entry happened to
 * be inserted last. It intermittently named Haiku as the model in use on a
 * conversation pinned to Opus, and, worse, sized the context bar against
 * Haiku's 200K window instead of Opus's 1M, overstating context use ~5x.
 */

import type { ModelUsageInfo } from './types';

/**
 * Total tokens attributable to a model for this turn. Output tokens dominate
 * the choice because generating the answer is what identifies the model that
 * actually served the conversation; input/cache tokens are included only to
 * break ties for turns that produced very little output.
 */
function usageWeight(usage: ModelUsageInfo): number {
  const output = usage.outputTokens ?? 0;
  const input = (usage.inputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0);
  // Output is weighted far above input so a large cached prefix on a utility
  // call can never outrank the model that wrote the response.
  return output * 1000 + input;
}

/**
 * The model that did the substantive work of the turn, or null when there is
 * no usage to judge from.
 */
export function primaryModelId(
  modelUsage: Record<string, ModelUsageInfo> | undefined | null,
): string | null {
  if (!modelUsage) return null;
  const entries = Object.entries(modelUsage);
  if (entries.length === 0) return null;

  let best = entries[0];
  for (const entry of entries.slice(1)) {
    if (usageWeight(entry[1]) > usageWeight(best[1])) best = entry;
  }
  return best[0];
}

/** Usage record for {@link primaryModelId}, or null. */
export function primaryModelUsage(
  modelUsage: Record<string, ModelUsageInfo> | undefined | null,
): ModelUsageInfo | null {
  const id = primaryModelId(modelUsage);
  return id ? modelUsage![id] : null;
}

/**
 * Models that were used for the turn but did not do its substantive work —
 * the CLI's small-fast model and anything else that ran alongside. Surfaced
 * so utility usage is visible rather than silently folded into the total.
 */
export function secondaryModelIds(
  modelUsage: Record<string, ModelUsageInfo> | undefined | null,
): string[] {
  if (!modelUsage) return [];
  const primary = primaryModelId(modelUsage);
  return Object.keys(modelUsage).filter((id) => id !== primary);
}
