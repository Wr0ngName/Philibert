/**
 * Per-model token rates, and the cost arithmetic that uses them.
 *
 * Why a static table at all, when the SDK reports cost directly?
 *
 * Because channel sessions deliberately bypass the SDK. `ChannelSession` runs
 * Claude Code inside a PTY so the CLI detects an interactive terminal and
 * bills against the subscription instead of the SDK credit pool, and the only
 * usage signal on that path is the CLI's own session JSONL. Those entries
 * carry `message.usage` token counts and nothing else — no `costUSD`, no
 * `total_cost_usd` (verified against live session files: zero occurrences of
 * any cost field across every assistant entry). The CLI prices the tokens
 * internally and never writes the result down.
 *
 * The SDK path needs none of this: `SDKMessageHandler` reads `costUSD` and
 * `total_cost_usd` straight off the result message. This table exists solely
 * to price the tokens the JSONL gives us, and is the one place rates live.
 *
 * Rates are USD per million tokens, from
 * https://platform.claude.com/docs/en/about-claude/pricing
 */

import { isRealModelId, modelVersionRank, parseModelId, stripContextVariant, stripDateSuffix } from './model-id';

/** Token rates for a single model, USD per million tokens. */
export interface ModelRates {
  /** Base (uncached) input tokens. */
  input: number;
  /** Output tokens. */
  output: number;
  /**
   * Cache hits, as a multiple of {@link ModelRates.input}. The standard
   * multiplier is 0.1; Opus 5.5 is 0.05 and Fable/Mythos 5.1 are 0.025.
   */
  cacheReadMultiplier: number;
}

/** 5-minute cache writes cost 1.25x the base input price on every model. */
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;

/** 1-hour cache writes cost 2x the base input price on every model. */
export const CACHE_WRITE_1H_MULTIPLIER = 2;

/** The cache-hit multiplier every model uses unless it says otherwise. */
const STANDARD_CACHE_READ_MULTIPLIER = 0.1;

function rates(input: number, output: number, cacheReadMultiplier = STANDARD_CACHE_READ_MULTIPLIER): ModelRates {
  return { input, output, cacheReadMultiplier };
}

/**
 * Rates keyed by alias model ID — the form the CLI writes into the session
 * JSONL (`claude-opus-5`, `claude-opus-4-7`), without dated snapshot or
 * context-window suffixes.
 *
 * Keyed by model rather than by family because a family is not a price: Opus
 * spans $4/$20 (5.5), $5/$25 (4.5 through 5) and $15/$75 (4 and 4.1) at the
 * same time. Pricing the whole family at one rate is how this drifted to
 * ~3-4x overstatement on every current Opus.
 */
const MODEL_RATES: Readonly<Record<string, ModelRates>> = {
  // Fable / Mythos tier.
  'claude-fable-5-1': rates(10, 50, 0.025),
  'claude-mythos-5-1': rates(10, 50, 0.025),
  'claude-fable-5': rates(10, 50),
  'claude-mythos-5': rates(10, 50),
  // Opus tier.
  'claude-opus-5-5': rates(4, 20, 0.05),
  'claude-opus-5': rates(5, 25),
  'claude-opus-4-8': rates(5, 25),
  'claude-opus-4-7': rates(5, 25),
  'claude-opus-4-6': rates(5, 25),
  'claude-opus-4-5': rates(5, 25),
  'claude-opus-4-1': rates(15, 75),
  'claude-opus-4': rates(15, 75),
  // Sonnet tier.
  'claude-sonnet-5': rates(2, 10),
  'claude-sonnet-4-6': rates(3, 15),
  'claude-sonnet-4-5': rates(3, 15),
  'claude-sonnet-4': rates(3, 15),
  // Haiku tier.
  'claude-haiku-4-5': rates(1, 5),
  'claude-haiku-3-5': rates(0.8, 4),
};

/** Reduce any model identifier to the key form {@link MODEL_RATES} uses. */
function toRateKey(modelId: string): string {
  return stripContextVariant(stripDateSuffix(modelId));
}

/**
 * Newest known model in a family, used to price a release the table has not
 * caught up with yet. A new Opus minor is far closer to the newest Opus than
 * to any other family, so this degrades gracefully instead of silently
 * charging Sonnet rates for Opus tokens — which is what the family-keyed
 * lookup this replaced did for every unrecognised ID.
 */
function newestInFamily(family: string): ModelRates | null {
  let best: { rank: number; rates: ModelRates } | null = null;
  for (const [id, modelRates] of Object.entries(MODEL_RATES)) {
    if (parseModelId(id)?.family !== family) continue;
    const rank = modelVersionRank(id);
    if (!best || rank > best.rank) best = { rank, rates: modelRates };
  }
  return best?.rates ?? null;
}

/**
 * Rates for a model ID, or null when none can be determined.
 *
 * Null covers two cases that must not be priced: the CLI's non-model
 * sentinels (`<synthetic>`, which it stamps on locally fabricated assistant
 * messages such as quota notices — the JSONL carries these alongside real
 * turns), and any ID from a family this table has never heard of. Callers
 * report those as unpriced rather than inventing a number for them.
 */
export function ratesForModel(modelId: string): ModelRates | null {
  if (!isRealModelId(modelId)) return null;

  const key = toRateKey(modelId);
  const exact = MODEL_RATES[key];
  if (exact) return exact;

  const family = parseModelId(key)?.family;
  return family ? newestInFamily(family) : null;
}

/** Token counts for one model over some span of a session. */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  /** Cache writes with the 5-minute TTL, billed at 1.25x base input. */
  cacheCreation5mInputTokens: number;
  /** Cache writes with the 1-hour TTL, billed at 2x base input. */
  cacheCreation1hInputTokens: number;
}

/** Cache-write tokens split by TTL, as `usage.cache_creation` reports them. */
interface CacheCreationBreakdown {
  ephemeral_5m_input_tokens?: unknown;
  ephemeral_1h_input_tokens?: unknown;
}

/**
 * Token counts from an API `usage` object — the shape the CLI writes into
 * `message.usage` in its session JSONL.
 *
 * `usage.cache_creation` carries the per-TTL breakdown and
 * `usage.cache_creation_input_tokens` the total. A payload without the
 * breakdown bills everything at the 5-minute rate, the cheaper of the two, so
 * an unattributable write is never overstated.
 */
export function tokenCountsFromApiUsage(usage: Record<string, unknown>): TokenCounts {
  const cacheCreationTotal = Number(usage.cache_creation_input_tokens) || 0;
  const breakdown = usage.cache_creation as CacheCreationBreakdown | undefined;

  let fiveMinute = cacheCreationTotal;
  let oneHour = 0;

  if (breakdown && typeof breakdown === 'object') {
    fiveMinute = Number(breakdown.ephemeral_5m_input_tokens) || 0;
    oneHour = Number(breakdown.ephemeral_1h_input_tokens) || 0;
    // A breakdown that does not account for the reported total leaves a
    // remainder; bill it at the 5-minute rate rather than dropping it.
    fiveMinute += Math.max(0, cacheCreationTotal - fiveMinute - oneHour);
  }

  return {
    inputTokens: Number(usage.input_tokens) || 0,
    outputTokens: Number(usage.output_tokens) || 0,
    cacheReadInputTokens: Number(usage.cache_read_input_tokens) || 0,
    cacheCreation5mInputTokens: fiveMinute,
    cacheCreation1hInputTokens: oneHour,
  };
}

/**
 * Cost in USD for a model's token counts, or null when the model cannot be
 * priced (see {@link ratesForModel}).
 *
 * The two cache-write buckets are billed separately because their multipliers
 * differ by 1.6x and real sessions are dominated by the 1-hour TTL — folding
 * both into the 5-minute rate, as the previous implementation did, undercounts
 * cache writes substantially.
 */
export function costUsdForModel(modelId: string, tokens: TokenCounts): number | null {
  const modelRates = ratesForModel(modelId);
  if (!modelRates) return null;

  const perToken = modelRates.input / 1_000_000;
  return (
    tokens.inputTokens * perToken +
    tokens.cacheReadInputTokens * perToken * modelRates.cacheReadMultiplier +
    tokens.cacheCreation5mInputTokens * perToken * CACHE_WRITE_5M_MULTIPLIER +
    tokens.cacheCreation1hInputTokens * perToken * CACHE_WRITE_1H_MULTIPLIER +
    (tokens.outputTokens * modelRates.output) / 1_000_000
  );
}

/** Round a USD amount to the sixth decimal, the granularity costs are reported at. */
export function roundUsd(amount: number): number {
  return Math.round(amount * 1_000_000) / 1_000_000;
}
