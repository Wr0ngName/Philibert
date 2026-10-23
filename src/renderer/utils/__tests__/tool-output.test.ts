import { describe, it, expect } from 'vitest';

import { formatToolOutput } from '../tool-output';

describe('formatToolOutput', () => {
  it('pretty-prints a compact JSON object', () => {
    expect(formatToolOutput('{"a":1,"b":[true]}')).toBe('{\n  "a": 1,\n  "b": [\n    true\n  ]\n}');
  });

  it('pretty-prints a JSON array, ignoring surrounding whitespace', () => {
    expect(formatToolOutput('\n[1,2]\n')).toBe('[\n  1,\n  2\n]');
  });

  it('leaves text, JSON scalars and invalid JSON exactly as written', () => {
    expect(formatToolOutput('total 8\ndrwxr-xr-x  .')).toBe('total 8\ndrwxr-xr-x  .');
    expect(formatToolOutput('42')).toBe('42');
    expect(formatToolOutput('{ not json')).toBe('{ not json');
  });
});
