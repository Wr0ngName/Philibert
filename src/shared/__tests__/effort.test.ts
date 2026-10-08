import { describe, it, expect } from 'vitest';

import {
  clampEffort,
  DEFAULT_EFFORT,
  describeEffortLevel,
  EFFORT_LEVELS,
  effortLevelsFor,
  findModelRow,
  formatEffortLevel,
  isEffortLevel,
  PERSISTABLE_EFFORT_LEVELS,
  resolveEffortForSelection,
  toPersistedEffort,
} from '../effort';
import type { EffortLevel, ModelInfo } from '../types';

function model(overrides: Partial<ModelInfo>): ModelInfo {
  return { value: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', ...overrides };
}

describe('isEffortLevel', () => {
  it('accepts every defined level and nothing else', () => {
    for (const level of EFFORT_LEVELS) expect(isEffortLevel(level)).toBe(true);
    expect(isEffortLevel('ultra')).toBe(false);
    expect(isEffortLevel('HIGH')).toBe(false);
    expect(isEffortLevel(undefined)).toBe(false);
    expect(isEffortLevel(3)).toBe(false);
  });
});

describe('effortLevelsFor', () => {
  it('uses the SDK list verbatim, in canonical order', () => {
    // The real 2.1.280 payload reports all five for Opus, in this order.
    const levels = effortLevelsFor(
      model({ supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }),
    );
    expect(levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('reorders and de-duplicates a list given out of order', () => {
    expect(effortLevelsFor(model({ supportedEffortLevels: ['high', 'low', 'high'] })))
      .toEqual(['low', 'high']);
  });

  it('treats an explicitly empty list as "no effort"', () => {
    expect(effortLevelsFor(model({ supportedEffortLevels: [] }))).toEqual([]);
  });

  it('treats supportsEffort: false as a definite no', () => {
    // The Haiku row the CLI returns carries no effort fields at all; a row
    // that says false explicitly must be honoured.
    expect(effortLevelsFor(model({ supportsEffort: false }))).toEqual([]);
  });

  it('falls back to the baseline three when support is claimed without a list', () => {
    // xhigh and max are later additions — never offered on a guess.
    expect(effortLevelsFor(model({ supportsEffort: true })))
      .toEqual(['low', 'medium', 'high']);
  });

  it('returns nothing when the SDK never described the row', () => {
    // Catalog-supplied versions carry no capability fields. Unknown is not
    // the same as "all levels", so the picker stays hidden rather than
    // offering levels the model may ignore.
    expect(effortLevelsFor(model({}))).toEqual([]);
    expect(effortLevelsFor(undefined)).toEqual([]);
    expect(effortLevelsFor(null)).toEqual([]);
  });
});

describe('clampEffort', () => {
  const all = EFFORT_LEVELS;

  it('passes a supported level through', () => {
    for (const level of all) expect(clampEffort(level, all)).toBe(level);
  });

  it('returns null when the model accepts no effort', () => {
    expect(clampEffort('high', [])).toBeNull();
  });

  it('steps down to the strongest allowed level at or below the request', () => {
    // A model without xhigh/max must not silently receive them.
    const upTo = ['low', 'medium', 'high'] as EffortLevel[];
    expect(clampEffort('max', upTo)).toBe('high');
    expect(clampEffort('xhigh', upTo)).toBe('high');
    expect(clampEffort('medium', upTo)).toBe('medium');
  });

  it('never returns a level stronger than requested', () => {
    const highOnly = ['high', 'xhigh', 'max'] as EffortLevel[];
    // 'low' is below everything on offer, so the weakest available is the
    // closest — this is the one case where it must step up.
    expect(clampEffort('low', highOnly)).toBe('high');
    // Everywhere else, stepping down is the rule.
    expect(clampEffort('max', ['low'] as EffortLevel[])).toBe('low');
  });

  it('ignores unknown levels in the allowed set', () => {
    const dirty = ['nonsense', 'high'] as unknown as EffortLevel[];
    expect(clampEffort('max', dirty)).toBe('high');
  });
});

describe('toPersistedEffort', () => {
  it('passes through every persistable level', () => {
    for (const level of PERSISTABLE_EFFORT_LEVELS) {
      expect(toPersistedEffort(level)).toBe(level);
    }
  });

  it('downgrades max to xhigh', () => {
    // The CLI's Settings.effortLevel is typed without 'max' — it is
    // session-only and never written to a settings file, so the channel path
    // gets the strongest level that can be persisted.
    expect(toPersistedEffort('max')).toBe('xhigh');
  });

  it('never returns max', () => {
    for (const level of EFFORT_LEVELS) {
      expect(toPersistedEffort(level)).not.toBe('max');
    }
  });
});

describe('findModelRow', () => {
  // The shapes the real 2.1.280 payload produces.
  const rows: ModelInfo[] = [
    { value: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Opus (1M context)' },
    { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' },
  ];

  it('matches a row by its own value', () => {
    expect(findModelRow(rows, 'opus[1m]')?.value).toBe('opus[1m]');
  });

  it('matches an alias row by the model it resolves to', () => {
    // A selection persisted as the concrete version must still find the alias
    // row that carries the capability fields.
    expect(findModelRow(rows, 'claude-opus-5-5')?.value).toBe('opus[1m]');
    expect(findModelRow(rows, 'claude-opus-5-5[1m]')?.value).toBe('opus[1m]');
  });

  it('ignores context variants and dated snapshots when matching', () => {
    expect(findModelRow(rows, 'claude-fable-5-1')?.value).toBe('claude-fable-5-1[1m]');
    expect(findModelRow(rows, 'claude-haiku-4-5')?.value).toBe('haiku');
  });

  it('returns nothing for an empty or unknown selection', () => {
    expect(findModelRow(rows, '')).toBeUndefined();
    expect(findModelRow(rows, 'claude-sonnet-5')).toBeUndefined();
    expect(findModelRow([], 'opus[1m]')).toBeUndefined();
  });
});

describe('resolveEffortForSelection', () => {
  const described: ModelInfo[] = [
    {
      value: 'opus[1m]',
      resolvedModel: 'claude-opus-5-5[1m]',
      displayName: 'Opus (1M context)',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      value: 'haiku',
      resolvedModel: 'claude-haiku-4-5-20251001',
      displayName: 'Haiku',
      supportsEffort: false,
    },
  ];

  it('clamps to the levels the model reported', () => {
    expect(resolveEffortForSelection('max', 'opus[1m]', described)).toBe('max');
    expect(resolveEffortForSelection('xhigh', 'claude-opus-5-5', described)).toBe('xhigh');
  });

  it('sends no effort to a model that reported it takes none', () => {
    // The CLI's Haiku row carries no effort support; sending a level would be
    // meaningless, so the parameter is omitted entirely.
    expect(resolveEffortForSelection('high', 'haiku', described)).toBeNull();
    expect(resolveEffortForSelection('high', 'claude-haiku-4-5-20251001', described)).toBeNull();
  });

  it('passes the request through when no model is selected', () => {
    // The CLI picks the model, so it also decides whether the level applies.
    expect(resolveEffortForSelection('max', '', described)).toBe('max');
  });

  it('passes the request through for a model with no row yet', () => {
    // The list loads asynchronously; dropping the user's choice because of
    // that would silently change behaviour on the first turn.
    expect(resolveEffortForSelection('max', 'claude-sonnet-5', described)).toBe('max');
    expect(resolveEffortForSelection('low', 'opus[1m]', [])).toBe('low');
  });

  it('passes the request through for a row the SDK never described', () => {
    // Catalog-supplied versions have no capability fields. Unknown must not
    // be read as unsupported, which would silently disable the feature.
    const undescribed: ModelInfo[] = [
      { value: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', description: '1M context' },
    ];
    expect(resolveEffortForSelection('xhigh', 'claude-opus-4-8', undescribed)).toBe('xhigh');
  });

  it('steps down rather than up when the model lists fewer levels', () => {
    const limited: ModelInfo[] = [
      { value: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', supportedEffortLevels: ['low', 'medium', 'high'] },
    ];
    expect(resolveEffortForSelection('max', 'claude-opus-4-6', limited)).toBe('high');
  });
});

describe('labels', () => {
  it('labels and describes every level', () => {
    for (const level of EFFORT_LEVELS) {
      expect(formatEffortLevel(level)).toBeTruthy();
      expect(describeEffortLevel(level)).toBeTruthy();
    }
  });

  it('spells xhigh out rather than mangling its case', () => {
    expect(formatEffortLevel('xhigh')).toBe('Extra high');
  });
});

describe('DEFAULT_EFFORT', () => {
  it('is the level the SDK itself defaults to', () => {
    expect(DEFAULT_EFFORT).toBe('high');
  });
});
