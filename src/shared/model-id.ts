/**
 * Canonical Claude model-ID parsing, shared by main and renderer.
 *
 * Model IDs come in two shapes, and both are current:
 *
 *   claude-{family}-{major}-{minor}   e.g. claude-opus-4-8, claude-sonnet-4-6
 *   claude-{family}-{major}           e.g. claude-opus-5, claude-fable-5, claude-sonnet-5
 *
 * The Claude 5 generation dropped the minor segment. Regexes written against
 * the two-segment shape (`claude-([a-z]+)-\d+-\d+`) silently fail to match the
 * whole Claude 5 family, which previously caused those models to be dropped
 * from the model picker and sorted to the bottom of the list — leaving no way
 * to pin Opus 5 and no way to see that Fable 5 was in play. Every call site
 * now goes through this module so that class of bug can only be fixed once.
 *
 * IDs may also carry a dated snapshot suffix (`-20250929`, `-20251001-v1`) or a
 * variant suffix (`-fast`); both are tolerated.
 */

/** A model ID broken into its component parts. */
export interface ParsedModelId {
  /** Lower-case family key, e.g. 'opus', 'sonnet', 'haiku', 'fable'. */
  family: string;
  /** Major version, e.g. 5 for claude-opus-5, 4 for claude-opus-4-8. */
  major: number;
  /** Minor version, or null for single-segment IDs like claude-opus-5. */
  minor: number | null;
}

/**
 * Matches the leading `claude-{family}-{major}[-{minor}]` of a model ID.
 * Deliberately unanchored at the tail so `-fast` and other variant suffixes
 * still parse. Call {@link stripDateSuffix} first so a dated snapshot's date
 * is never mistaken for the minor version.
 */
const MODEL_ID_PATTERN = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/;

/** Dated snapshot suffix, e.g. `-20250929` or `-20251001-v1`. */
const DATE_SUFFIX_PATTERN = /-\d{8}(-v\d+)?$/;

/**
 * Context-window variant suffix, e.g. the `[1m]` in `opus[1m]` or
 * `claude-opus-5[1m]`. The CLI uses it to distinguish the 1M-context flavour
 * of a model from its default one, and `supportedModels()` returns values
 * carrying it. It is part of the selectable identifier, so it must be kept in
 * `value` — but it is not part of the family or version and has to come off
 * before either is parsed.
 */
const CONTEXT_VARIANT_PATTERN = /(\[\d+m\])+$/i;

/**
 * Remove a trailing context-window variant marker. `opus[1m]` → `opus`,
 * `claude-opus-5[1m]` → `claude-opus-5`. Returns the input unchanged when
 * there is no marker.
 */
export function stripContextVariant(modelId: string): string {
  return modelId.replace(CONTEXT_VARIANT_PATTERN, '');
}

/**
 * The context-window variant marker on a model ID, without brackets — `1m`
 * for `opus[1m]` — or null when the ID carries none. Used to label the
 * variant in the picker so two rows of the same family are distinguishable.
 */
export function contextVariant(modelId: string): string | null {
  const match = modelId.match(CONTEXT_VARIANT_PATTERN);
  return match ? match[0].replace(/[[\]]/g, '') : null;
}

/**
 * Family key for any value `supportedModels()` can return, covering all three
 * shapes it actually uses: a bare alias (`sonnet`), an alias with a context
 * variant (`opus[1m]`), and a full model ID with or without one
 * (`claude-fable-5[1m]`). Returns null for `default`, which names no family.
 */
export function familyKeyOf(value: string): string | null {
  if (!value || value === 'default') return null;
  const bare = stripContextVariant(value);
  const parsed = parseModelId(bare);
  if (parsed) return parsed.family;
  // A bare alias is itself the family name; anything hyphenated that failed
  // to parse is not a model we can classify.
  return bare.includes('-') ? null : bare;
}

/**
 * Reduce any model ID to its alias form by dropping a dated snapshot suffix.
 * `claude-sonnet-4-5-20250929` → `claude-sonnet-4-5`. IDs without a date are
 * returned unchanged.
 */
export function stripDateSuffix(modelId: string): string {
  return modelId.replace(DATE_SUFFIX_PATTERN, '');
}

/**
 * Parse a model ID into family/major/minor, or return null if it isn't a
 * `claude-*` versioned ID (bare family aliases like `opus` and the special
 * `default` entry both return null — they carry no version).
 */
export function parseModelId(modelId: string): ParsedModelId | null {
  const match = stripContextVariant(stripDateSuffix(modelId)).match(MODEL_ID_PATTERN);
  if (!match) return null;
  return {
    family: match[1],
    major: Number(match[2]),
    minor: match[3] === undefined ? null : Number(match[3]),
  };
}

/**
 * Family key for a model ID, or null when the ID carries no family.
 */
export function modelFamily(modelId: string): string | null {
  return parseModelId(modelId)?.family ?? null;
}

/**
 * Comparable version rank, newest-highest. `claude-opus-5` (500) outranks
 * `claude-opus-4-8` (408). A missing minor counts as .0, so `claude-opus-4`
 * and `claude-opus-4-0` rank identically — they are the same model.
 */
export function modelVersionRank(modelId: string): number {
  const parsed = parseModelId(modelId);
  if (!parsed) return 0;
  return parsed.major * 100 + (parsed.minor ?? 0);
}

/** `{major}.{minor}`, or just `{major}` when there is no minor segment. */
export function formatVersion(parsed: ParsedModelId): string {
  return parsed.minor === null ? `${parsed.major}` : `${parsed.major}.${parsed.minor}`;
}

/** Capitalize a family key for display: 'opus' → 'Opus'. */
export function capitalizeFamily(family: string): string {
  return family.length === 0 ? family : family.charAt(0).toUpperCase() + family.slice(1);
}

/**
 * Human-readable short label: `claude-sonnet-4-5-20250929` → "Sonnet 4.5",
 * `claude-opus-5` → "Opus 5". Returns the input unchanged when it isn't a
 * versioned model ID, so family aliases still render something readable.
 */
export function formatModelId(modelId: string): string {
  const parsed = parseModelId(modelId);
  if (!parsed) return modelId;
  return `${capitalizeFamily(parsed.family)} ${formatVersion(parsed)}`;
}

/**
 * Full display name as used in the model picker: "Claude Opus 4.8".
 */
export function formatModelDisplayName(parsed: ParsedModelId): string {
  return `Claude ${capitalizeFamily(parsed.family)} ${formatVersion(parsed)}`;
}

/**
 * Sentinels the CLI puts in a message's `model` field when the message did not
 * come from a model at all. `<synthetic>` is stamped on assistant messages the
 * CLI fabricates locally — quota and rate-limit notices, "No response
 * requested", "(no content)". Treating one as a real model reading produces a
 * nonsense report like "you selected Opus 4.8, but Claude Code is running
 * <synthetic>" in place of the actual quota error.
 */
const NON_MODEL_SENTINELS = new Set(['<synthetic>', 'default', '(no content)']);

/**
 * Whether a reported `model` value names an actual model, as opposed to a CLI
 * sentinel or an empty field. Anything bracketed is a sentinel by construction.
 */
export function isRealModelId(modelId: string | undefined | null): boolean {
  if (!modelId) return false;
  if (NON_MODEL_SENTINELS.has(modelId)) return false;
  if (modelId.startsWith('<')) return false;
  return true;
}

/**
 * True when two model identifiers refer to the same model, ignoring dated
 * snapshot suffixes. Used to tell a real model substitution apart from the
 * API reporting a pinned snapshot of the model that was actually requested
 * (`claude-sonnet-4-5` requested, `claude-sonnet-4-5-20250929` reported).
 */
export function isSameModel(a: string, b: string): boolean {
  if (!a || !b) return false;
  // Context-window variants are the same underlying model: `claude-opus-5` and
  // `claude-opus-5[1m]` are both Opus 5, so reporting one while the other was
  // selected is not a substitution.
  const normalize = (v: string) => stripContextVariant(stripDateSuffix(v));
  return normalize(a) === normalize(b);
}
