/**
 * Reasoning-effort levels, and the rules for picking one for a given model.
 *
 * Which levels a model accepts is deliberately not knowledge this app holds.
 * The SDK reports it per model on `ModelInfo.supportedEffortLevels`, and the
 * set really does differ: `xhigh` arrived with Opus 4.7, and the Haiku row the
 * CLI returns carries no effort support at all. Everything here derives from
 * what the SDK said, and falls back only where it said nothing.
 *
 * Two shapes of consumer, with different reach:
 *
 *   - The SDK path passes `effort` as a query option and can express every
 *     level, `max` included.
 *   - The channel path configures its session by writing a CLI settings file,
 *     and the CLI's persisted `effortLevel` key is typed without `max` —
 *     that level is session-only and never written to disk. Such a caller
 *     uses {@link toPersistedEffort} and gets `xhigh` instead.
 */

import { isSameModel } from './model-id';
import type { EffortLevel, ModelInfo } from './types';

/**
 * Every level the SDK defines, weakest first. This order is the picker's
 * order and the direction {@link clampEffort} searches.
 */
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The level a model runs at when no effort is requested. Matches the SDK's default. */
export const DEFAULT_EFFORT: EffortLevel = 'high';

/**
 * Levels that survive being written to a CLI settings file. `max` is absent
 * because the CLI treats it as session-only and never persists it.
 */
export const PERSISTABLE_EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];

/**
 * Levels assumed for a model that says it supports effort without listing
 * which levels. Only the three the effort parameter shipped with — `xhigh`
 * and `max` are later additions and must not be offered on a guess.
 */
const BASELINE_EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high'];

/**
 * Resolves the effort level to use for a selected model, already clamped to
 * what that model accepts, or null when it accepts none.
 *
 * Exists as a contract because the authoritative model rows — the ones
 * carrying each model's supported levels — are owned by one service, while
 * both execution paths need the same answer. Injecting the resolver keeps a
 * single implementation instead of letting the two paths drift.
 */
export type EffortResolver = (selectedModel: string) => Promise<EffortLevel | null>;

/** Whether a value is one of the known effort levels. */
export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** Rank of a level, weakest = 0. Returns -1 for anything unrecognised. */
function rankOf(level: EffortLevel): number {
  return EFFORT_LEVELS.indexOf(level);
}

/** Sort a level set into canonical weakest-first order, dropping unknowns and duplicates. */
function canonical(levels: readonly EffortLevel[]): EffortLevel[] {
  return EFFORT_LEVELS.filter((level) => levels.includes(level));
}

/**
 * The effort levels a model accepts, weakest first.
 *
 * Empty means no effort should be sent for this model — either the SDK said
 * it supports none, or there is no row to ask (the model list has not loaded,
 * or the selection names something the SDK did not offer). Sending an
 * unsupported level is not dangerous — the CLI silently downgrades it — but
 * offering a level the model will ignore misrepresents what the picker does.
 */
export function effortLevelsFor(model: ModelInfo | undefined | null): EffortLevel[] {
  if (!model) return [];

  // An explicit list is the authoritative answer, including when it is empty.
  if (model.supportedEffortLevels) return canonical(model.supportedEffortLevels);

  // No list. `supportsEffort: false` is a definite no; `true` without a list
  // means fall back to the baseline; absent means the SDK never described
  // this row (a catalog-supplied version), which is unknown, not no.
  if (model.supportsEffort === false) return [];
  if (model.supportsEffort === true) return [...BASELINE_EFFORT_LEVELS];
  return [];
}

/**
 * Reduce a requested level to one the model actually accepts.
 *
 * Returns null when `allowed` is empty — the caller should then send no effort
 * at all rather than substituting a default. Otherwise it never returns a
 * level stronger than requested: it steps down to the strongest allowed level
 * at or below the request, and only steps up when the request is below
 * everything on offer.
 */
export function clampEffort(
  requested: EffortLevel,
  allowed: readonly EffortLevel[],
): EffortLevel | null {
  const permitted = canonical(allowed);
  if (permitted.length === 0) return null;
  if (permitted.includes(requested)) return requested;

  const wanted = rankOf(requested);
  let best: EffortLevel | null = null;
  for (const level of permitted) {
    if (rankOf(level) <= wanted) best = level;
  }
  // Nothing at or below the request — the model's weakest level is the
  // closest it can get.
  return best ?? permitted[0];
}

/**
 * The model row a selection refers to.
 *
 * A selection can name an alias row (`opus[1m]`) or the concrete version that
 * alias resolves to (`claude-opus-5-5[1m]`), and only one of those rows exists
 * in the list — so both spellings have to be tried before concluding a model
 * is unknown. Context variants and dated snapshots are the same model, which
 * is why the comparison goes through `isSameModel`.
 */
export function findModelRow(
  models: readonly ModelInfo[],
  selection: string,
): ModelInfo | undefined {
  if (!selection) return undefined;
  return models.find((m) => isSameModel(m.value, selection))
    ?? models.find((m) => m.resolvedModel && isSameModel(m.resolvedModel, selection));
}

/**
 * The effort level to actually send for a selection, or null to send none.
 *
 * Three distinct outcomes, and the difference between the last two matters:
 *
 *   - The model reported which levels it takes → the request, clamped to them.
 *   - The model reported that it takes none → null, so no effort is sent.
 *   - Nothing is known about the model (no selection, no row for it, or a row
 *     the SDK never described) → the request, unclamped. The CLI downgrades
 *     an unsupported level itself, whereas suppressing effort here would
 *     silently discard the user's choice because a list had not loaded yet.
 */
export function resolveEffortForSelection(
  requested: EffortLevel,
  selection: string,
  models: readonly ModelInfo[],
): EffortLevel | null {
  const row = findModelRow(models, selection);
  if (!row) return requested;

  const allowed = effortLevelsFor(row);
  if (allowed.length > 0) return clampEffort(requested, allowed);

  // No levels. Only a row that actually described its capabilities can rule
  // effort out; an undescribed row is unknown, not unsupported.
  const described = row.supportedEffortLevels !== undefined || row.supportsEffort !== undefined;
  return described ? null : requested;
}

/**
 * The level to write into a CLI settings file for a requested level.
 *
 * `max` cannot be persisted, so it becomes the strongest level that can be:
 * `xhigh`. Any other level passes through unchanged.
 */
export function toPersistedEffort(level: EffortLevel): Exclude<EffortLevel, 'max'> {
  if (PERSISTABLE_EFFORT_LEVELS.includes(level)) {
    return level as Exclude<EffortLevel, 'max'>;
  }
  const strongest = PERSISTABLE_EFFORT_LEVELS[PERSISTABLE_EFFORT_LEVELS.length - 1];
  return strongest as Exclude<EffortLevel, 'max'>;
}

/** Title-case label for a level: 'xhigh' → 'XHigh' is wrong, so spell them out. */
const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** Human-readable label for a level, for the picker. */
export function formatEffortLevel(level: EffortLevel): string {
  return EFFORT_LABELS[level];
}

/** One-line description of what a level trades, for the picker's subtitle. */
const EFFORT_DESCRIPTIONS: Record<EffortLevel, string> = {
  low: 'Minimal thinking, fastest and cheapest',
  medium: 'Moderate thinking',
  high: 'Deep reasoning — the default',
  xhigh: 'Deeper than high, best for coding and agentic work',
  max: 'Maximum effort, when correctness matters more than cost',
};

/** Human-readable description for a level. */
export function describeEffortLevel(level: EffortLevel): string {
  return EFFORT_DESCRIPTIONS[level];
}
