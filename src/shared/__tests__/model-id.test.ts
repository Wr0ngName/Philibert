import { describe, it, expect } from 'vitest';

import {
  capitalizeFamily,
  contextVariant,
  familyKeyOf,
  formatModelDisplayName,
  formatModelId,
  formatVersion,
  isRealModelId,
  isSameModel,
  modelFamily,
  modelVersionRank,
  parseModelId,
  stripContextVariant,
  stripDateSuffix,
} from '../model-id';

describe('stripDateSuffix', () => {
  it('drops a dated snapshot suffix', () => {
    expect(stripDateSuffix('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(stripDateSuffix('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
  });

  it('drops a dated snapshot suffix with a revision', () => {
    expect(stripDateSuffix('claude-opus-4-1-20250805-v1')).toBe('claude-opus-4-1');
  });

  it('leaves undated IDs untouched', () => {
    expect(stripDateSuffix('claude-opus-5')).toBe('claude-opus-5');
    expect(stripDateSuffix('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(stripDateSuffix('opus')).toBe('opus');
  });
});

describe('parseModelId', () => {
  // The Claude 5 generation dropped the minor segment. The previous
  // `claude-([a-z]+)-\d+-\d+` regexes matched none of these, which is why
  // Opus 5 / Sonnet 5 / Fable 5 were invisible in the model picker.
  it('parses single-segment Claude 5 IDs', () => {
    expect(parseModelId('claude-opus-5')).toEqual({ family: 'opus', major: 5, minor: null });
    expect(parseModelId('claude-fable-5')).toEqual({ family: 'fable', major: 5, minor: null });
    expect(parseModelId('claude-sonnet-5')).toEqual({ family: 'sonnet', major: 5, minor: null });
    expect(parseModelId('claude-mythos-5')).toEqual({ family: 'mythos', major: 5, minor: null });
  });

  it('parses two-segment Claude 4 IDs', () => {
    expect(parseModelId('claude-opus-4-8')).toEqual({ family: 'opus', major: 4, minor: 8 });
    expect(parseModelId('claude-sonnet-4-6')).toEqual({ family: 'sonnet', major: 4, minor: 6 });
    expect(parseModelId('claude-haiku-4-5')).toEqual({ family: 'haiku', major: 4, minor: 5 });
  });

  it('parses dated snapshots without mistaking the date for a minor version', () => {
    expect(parseModelId('claude-sonnet-4-5-20250929')).toEqual({
      family: 'sonnet', major: 4, minor: 5,
    });
    // Single-segment version plus a date: the date must not become the minor.
    expect(parseModelId('claude-opus-4-20250514')).toEqual({
      family: 'opus', major: 4, minor: null,
    });
  });

  it('parses variant suffixes such as -fast', () => {
    expect(parseModelId('claude-opus-4-6-fast')).toEqual({ family: 'opus', major: 4, minor: 6 });
  });

  it('returns null for bare family aliases and non-model values', () => {
    expect(parseModelId('opus')).toBeNull();
    expect(parseModelId('sonnet')).toBeNull();
    expect(parseModelId('default')).toBeNull();
    expect(parseModelId('')).toBeNull();
  });
});

describe('modelFamily', () => {
  it('extracts the family for both ID shapes', () => {
    expect(modelFamily('claude-opus-5')).toBe('opus');
    expect(modelFamily('claude-sonnet-4-6')).toBe('sonnet');
  });

  it('returns null when there is no family to extract', () => {
    expect(modelFamily('default')).toBeNull();
  });
});

describe('modelVersionRank', () => {
  it('ranks Claude 5 above the Claude 4 generation', () => {
    expect(modelVersionRank('claude-opus-5')).toBeGreaterThan(modelVersionRank('claude-opus-4-8'));
    expect(modelVersionRank('claude-sonnet-5')).toBeGreaterThan(modelVersionRank('claude-sonnet-4-6'));
  });

  it('orders minor versions within a generation', () => {
    expect(modelVersionRank('claude-opus-4-8')).toBeGreaterThan(modelVersionRank('claude-opus-4-7'));
  });

  it('treats an absent minor as .0', () => {
    expect(modelVersionRank('claude-opus-4')).toBe(modelVersionRank('claude-opus-4-0'));
  });

  it('ranks unparseable values lowest', () => {
    expect(modelVersionRank('default')).toBe(0);
  });
});

describe('formatVersion', () => {
  it('omits the minor when there is none', () => {
    expect(formatVersion({ family: 'opus', major: 5, minor: null })).toBe('5');
  });

  it('renders major.minor when both are present', () => {
    expect(formatVersion({ family: 'opus', major: 4, minor: 8 })).toBe('4.8');
  });
});

describe('capitalizeFamily', () => {
  it('capitalizes a family key', () => {
    expect(capitalizeFamily('opus')).toBe('Opus');
    expect(capitalizeFamily('fable')).toBe('Fable');
  });

  it('handles the empty string', () => {
    expect(capitalizeFamily('')).toBe('');
  });
});

describe('formatModelId', () => {
  it('renders a short label for both ID shapes', () => {
    expect(formatModelId('claude-opus-5')).toBe('Opus 5');
    expect(formatModelId('claude-fable-5')).toBe('Fable 5');
    expect(formatModelId('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
  });

  it('returns the input unchanged when it is not a versioned model ID', () => {
    expect(formatModelId('opus')).toBe('opus');
    expect(formatModelId('default')).toBe('default');
  });
});

describe('formatModelDisplayName', () => {
  it('renders the full picker label', () => {
    expect(formatModelDisplayName({ family: 'opus', major: 5, minor: null })).toBe('Claude Opus 5');
    expect(formatModelDisplayName({ family: 'opus', major: 4, minor: 8 })).toBe('Claude Opus 4.8');
  });
});

describe('isSameModel', () => {
  it('treats a dated snapshot as the model it pins', () => {
    expect(isSameModel('claude-sonnet-4-5', 'claude-sonnet-4-5-20250929')).toBe(true);
  });

  it('distinguishes genuinely different models', () => {
    expect(isSameModel('claude-opus-5', 'claude-fable-5')).toBe(false);
    expect(isSameModel('claude-opus-5', 'claude-opus-4-8')).toBe(false);
  });

  it('is false when either side is missing', () => {
    expect(isSameModel('', 'claude-opus-5')).toBe(false);
    expect(isSameModel('claude-opus-5', '')).toBe(false);
  });
});

describe('isRealModelId', () => {
  // The CLI stamps `<synthetic>` on assistant messages it fabricates itself —
  // quota and rate-limit notices above all. Reading one as a model produced
  // "you selected Opus 4.8, but Claude Code is running <synthetic>" in place
  // of the actual quota error.
  it('rejects the synthetic sentinel', () => {
    expect(isRealModelId('<synthetic>')).toBe(false);
  });

  it('rejects other CLI sentinels and bracketed placeholders', () => {
    expect(isRealModelId('default')).toBe(false);
    expect(isRealModelId('(no content)')).toBe(false);
    expect(isRealModelId('<anything>')).toBe(false);
  });

  it('rejects empty and nullish values', () => {
    expect(isRealModelId('')).toBe(false);
    expect(isRealModelId(undefined)).toBe(false);
    expect(isRealModelId(null)).toBe(false);
  });

  it('accepts real model IDs and family aliases', () => {
    expect(isRealModelId('claude-opus-4-8')).toBe(true);
    expect(isRealModelId('claude-opus-5')).toBe(true);
    expect(isRealModelId('opus')).toBe(true);
  });
});

// Values below are the real output of supportedModels() on CLI 2.1.220,
// captured directly rather than assumed.
describe('context-window variants (the [1m] suffix)', () => {
  it('strips the variant marker', () => {
    expect(stripContextVariant('opus[1m]')).toBe('opus');
    expect(stripContextVariant('claude-opus-5[1m]')).toBe('claude-opus-5');
    expect(stripContextVariant('claude-fable-5[1m]')).toBe('claude-fable-5');
    expect(stripContextVariant('sonnet')).toBe('sonnet');
  });

  it('exposes the variant label', () => {
    expect(contextVariant('opus[1m]')).toBe('1m');
    expect(contextVariant('claude-opus-5[1m]')).toBe('1m');
    expect(contextVariant('sonnet')).toBeNull();
  });

  it('parses a versioned ID that carries a variant', () => {
    expect(parseModelId('claude-fable-5[1m]')).toEqual({ family: 'fable', major: 5, minor: null });
    expect(parseModelId('claude-opus-5[1m]')).toEqual({ family: 'opus', major: 5, minor: null });
  });

  it('treats a variant as the same underlying model', () => {
    expect(isSameModel('claude-opus-5', 'claude-opus-5[1m]')).toBe(true);
  });
});

describe('familyKeyOf — every shape supportedModels() returns', () => {
  it('handles bare aliases', () => {
    expect(familyKeyOf('sonnet')).toBe('sonnet');
    expect(familyKeyOf('haiku')).toBe('haiku');
  });

  // Regression: `opus[1m]` has no hyphen, so the picker's "contains a hyphen"
  // heuristic made it a family literally named "opus[1m]".
  it('handles an alias carrying a context variant', () => {
    expect(familyKeyOf('opus[1m]')).toBe('opus');
  });

  it('handles full model IDs with and without a variant', () => {
    expect(familyKeyOf('claude-fable-5[1m]')).toBe('fable');
    expect(familyKeyOf('claude-haiku-4-5-20251001')).toBe('haiku');
  });

  it('returns null for default and empty values', () => {
    expect(familyKeyOf('default')).toBeNull();
    expect(familyKeyOf('')).toBeNull();
  });
});
