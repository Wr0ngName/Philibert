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
  const match = stripDateSuffix(modelId).match(MODEL_ID_PATTERN);
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
  return stripDateSuffix(a) === stripDateSuffix(b);
}
