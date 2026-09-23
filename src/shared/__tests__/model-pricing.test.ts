import { describe, it, expect } from 'vitest';

import {
  CACHE_WRITE_1H_MULTIPLIER,
  CACHE_WRITE_5M_MULTIPLIER,
  costUsdForModel,
  ratesForModel,
  roundUsd,
  tokenCountsFromApiUsage,
} from '../model-pricing';

const NO_TOKENS = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreation5mInputTokens: 0,
  cacheCreation1hInputTokens: 0,
};

describe('ratesForModel', () => {
  it('prices each Opus generation at its own rate, not one family rate', () => {
    // The whole reason this table is keyed by model: Opus spans three price
    // points simultaneously.
    expect(ratesForModel('claude-opus-5-5')).toMatchObject({ input: 4, output: 20 });
    expect(ratesForModel('claude-opus-5')).toMatchObject({ input: 5, output: 25 });
    expect(ratesForModel('claude-opus-4-8')).toMatchObject({ input: 5, output: 25 });
    expect(ratesForModel('claude-opus-4-1')).toMatchObject({ input: 15, output: 75 });
  });

  it('carries the non-standard cache-read multipliers', () => {
    expect(ratesForModel('claude-opus-5-5')!.cacheReadMultiplier).toBe(0.05);
    expect(ratesForModel('claude-fable-5-1')!.cacheReadMultiplier).toBe(0.025);
    expect(ratesForModel('claude-mythos-5-1')!.cacheReadMultiplier).toBe(0.025);
    // Everything else is the standard 0.1x, Fable 5 included.
    expect(ratesForModel('claude-fable-5')!.cacheReadMultiplier).toBe(0.1);
    expect(ratesForModel('claude-opus-5')!.cacheReadMultiplier).toBe(0.1);
    expect(ratesForModel('claude-sonnet-5')!.cacheReadMultiplier).toBe(0.1);
  });

  it('resolves dated snapshots and context variants to the base model', () => {
    expect(ratesForModel('claude-haiku-4-5-20251001')).toMatchObject({ input: 1, output: 5 });
    expect(ratesForModel('claude-sonnet-4-5-20250929')).toMatchObject({ input: 3, output: 15 });
    expect(ratesForModel('claude-opus-5[1m]')).toMatchObject({ input: 5, output: 25 });
    expect(ratesForModel('claude-opus-5-5[1m]')).toMatchObject({ input: 4, output: 20 });
  });

  it('falls back to the newest known model of the same family', () => {
    // A minor release the table has not caught up with must not be priced as
    // some other family. Opus 5.5 is the newest Opus, so it is the estimate.
    expect(ratesForModel('claude-opus-5-9')).toMatchObject({ input: 4, output: 20 });
    expect(ratesForModel('claude-sonnet-5-5')).toMatchObject({ input: 2, output: 10 });
  });

  it('refuses to price CLI sentinels', () => {
    // The JSONL stamps <synthetic> on locally fabricated assistant messages
    // (quota notices, "No response requested") and carries them next to real
    // turns. The family-keyed lookup this replaced billed them as Sonnet.
    expect(ratesForModel('<synthetic>')).toBeNull();
    expect(ratesForModel('default')).toBeNull();
    expect(ratesForModel('(no content)')).toBeNull();
    expect(ratesForModel('')).toBeNull();
  });

  it('refuses to price an unknown family', () => {
    expect(ratesForModel('claude-unheardof-1')).toBeNull();
    expect(ratesForModel('gpt-4')).toBeNull();
  });
});

describe('costUsdForModel', () => {
  it('prices base input and output at the model rate', () => {
    const cost = costUsdForModel('claude-opus-5', {
      ...NO_TOKENS,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(5 + 25, 10);
  });

  it('prices cache hits at the model multiplier', () => {
    // Opus 5: 0.1x of $5 = $0.50/MTok.
    expect(
      costUsdForModel('claude-opus-5', { ...NO_TOKENS, cacheReadInputTokens: 1_000_000 }),
    ).toBeCloseTo(0.5, 10);
    // Opus 5.5: 0.05x of $4 = $0.20/MTok.
    expect(
      costUsdForModel('claude-opus-5-5', { ...NO_TOKENS, cacheReadInputTokens: 1_000_000 }),
    ).toBeCloseTo(0.2, 10);
    // Fable 5.1: 0.025x of $10 = $0.25/MTok.
    expect(
      costUsdForModel('claude-fable-5-1', { ...NO_TOKENS, cacheReadInputTokens: 1_000_000 }),
    ).toBeCloseTo(0.25, 10);
  });

  it('bills the two cache-write TTLs at different multipliers', () => {
    const fiveMinute = costUsdForModel('claude-opus-5', {
      ...NO_TOKENS,
      cacheCreation5mInputTokens: 1_000_000,
    });
    const oneHour = costUsdForModel('claude-opus-5', {
      ...NO_TOKENS,
      cacheCreation1hInputTokens: 1_000_000,
    });

    expect(fiveMinute).toBeCloseTo(5 * CACHE_WRITE_5M_MULTIPLIER, 10); // $6.25/MTok
    expect(oneHour).toBeCloseTo(5 * CACHE_WRITE_1H_MULTIPLIER, 10); // $10/MTok
    // Real sessions are dominated by the 1h TTL, so collapsing both into the
    // 5m rate — what the previous implementation did — undercounts by 1.6x.
    expect(oneHour! / fiveMinute!).toBeCloseTo(1.6, 10);
  });

  it('sums every component', () => {
    const cost = costUsdForModel('claude-opus-5-5', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      cacheCreation5mInputTokens: 1_000_000,
      cacheCreation1hInputTokens: 1_000_000,
    });
    // 4 + 20 + 0.20 + 5 + 8
    expect(cost).toBeCloseTo(37.2, 10);
  });

  it('returns null for a model it cannot price', () => {
    expect(costUsdForModel('<synthetic>', { ...NO_TOKENS, inputTokens: 1_000_000 })).toBeNull();
  });

  it('is zero for zero tokens', () => {
    expect(costUsdForModel('claude-opus-5', NO_TOKENS)).toBe(0);
  });
});

describe('tokenCountsFromApiUsage', () => {
  it('reads the per-TTL cache-write breakdown', () => {
    expect(
      tokenCountsFromApiUsage({
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 },
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheCreation5mInputTokens: 40,
      cacheCreation1hInputTokens: 60,
    });
  });

  it('bills a breakdown that undershoots the total at the 5-minute rate', () => {
    // Never drop tokens the total says were written; the cheaper bucket
    // absorbs whatever the breakdown does not account for.
    const counts = tokenCountsFromApiUsage({
      cache_creation_input_tokens: 100,
      cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
    });
    expect(counts.cacheCreation5mInputTokens).toBe(80);
    expect(counts.cacheCreation1hInputTokens).toBe(20);
  });

  it('never returns a negative bucket when the breakdown exceeds the total', () => {
    const counts = tokenCountsFromApiUsage({
      cache_creation_input_tokens: 10,
      cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 },
    });
    expect(counts.cacheCreation5mInputTokens).toBe(40);
    expect(counts.cacheCreation1hInputTokens).toBe(60);
  });

  it('treats a missing breakdown as entirely 5-minute', () => {
    const counts = tokenCountsFromApiUsage({ cache_creation_input_tokens: 100 });
    expect(counts.cacheCreation5mInputTokens).toBe(100);
    expect(counts.cacheCreation1hInputTokens).toBe(0);
  });

  it('defaults every absent or non-numeric field to zero', () => {
    expect(tokenCountsFromApiUsage({})).toEqual(NO_TOKENS);
    expect(tokenCountsFromApiUsage({ input_tokens: 'lots', cache_creation: null })).toEqual(NO_TOKENS);
  });
});

describe('roundUsd', () => {
  it('rounds to the sixth decimal', () => {
    expect(roundUsd(1.23456789)).toBe(1.234568);
    expect(roundUsd(0.0000004)).toBe(0);
    expect(roundUsd(2)).toBe(2);
  });
});
