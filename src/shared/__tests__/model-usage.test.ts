import { describe, it, expect } from 'vitest';

import { primaryModelId, primaryModelUsage, secondaryModelIds } from '../model-usage';
import type { ModelUsageInfo } from '../types';

function usage(partial: Partial<ModelUsageInfo>): ModelUsageInfo {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
    ...partial,
  };
}

/**
 * A realistic turn: Opus answered the user, Haiku ran a title or summary.
 * Haiku is listed LAST, which is what the old "take the last key" logic
 * picked — reporting Haiku as the model on an Opus conversation.
 */
const MIXED_TURN: Record<string, ModelUsageInfo> = {
  'claude-opus-4-8': usage({ outputTokens: 4200, inputTokens: 18000, contextWindow: 1_000_000 }),
  'claude-haiku-4-5': usage({ outputTokens: 40, inputTokens: 900, contextWindow: 200_000 }),
};

describe('primaryModelId', () => {
  it('picks the model that generated the answer, not the last key', () => {
    expect(primaryModelId(MIXED_TURN)).toBe('claude-opus-4-8');
  });

  it('is independent of key order', () => {
    const reordered: Record<string, ModelUsageInfo> = {
      'claude-haiku-4-5': MIXED_TURN['claude-haiku-4-5'],
      'claude-opus-4-8': MIXED_TURN['claude-opus-4-8'],
    };
    expect(primaryModelId(reordered)).toBe('claude-opus-4-8');
  });

  it('does not let a large cached prefix outrank the answering model', () => {
    // A utility call can read a big cached prefix while writing almost nothing.
    const cachedHeavyUtility: Record<string, ModelUsageInfo> = {
      'claude-opus-4-8': usage({ outputTokens: 900, inputTokens: 100 }),
      'claude-haiku-4-5': usage({ outputTokens: 5, cacheReadInputTokens: 500_000 }),
    };
    expect(primaryModelId(cachedHeavyUtility)).toBe('claude-opus-4-8');
  });

  it('handles a single-model turn', () => {
    expect(primaryModelId({ 'claude-opus-4-8': usage({ outputTokens: 10 }) })).toBe('claude-opus-4-8');
  });

  it('returns null when there is nothing to judge', () => {
    expect(primaryModelId({})).toBeNull();
    expect(primaryModelId(undefined)).toBeNull();
    expect(primaryModelId(null)).toBeNull();
  });
});

describe('primaryModelUsage', () => {
  // The context bar sized itself from the last entry. Picking Haiku's 200K
  // window for an Opus conversation overstated context use roughly fivefold.
  it('returns the answering model\'s context window, not the utility one', () => {
    expect(primaryModelUsage(MIXED_TURN)?.contextWindow).toBe(1_000_000);
  });

  it('returns null when there is no usage', () => {
    expect(primaryModelUsage({})).toBeNull();
  });
});

describe('secondaryModelIds', () => {
  it('lists the models that ran alongside the primary one', () => {
    expect(secondaryModelIds(MIXED_TURN)).toEqual(['claude-haiku-4-5']);
  });

  it('is empty for a single-model turn', () => {
    expect(secondaryModelIds({ 'claude-opus-4-8': usage({ outputTokens: 10 }) })).toEqual([]);
  });

  it('is empty when there is no usage', () => {
    expect(secondaryModelIds(undefined)).toEqual([]);
  });
});
