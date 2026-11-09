/**
 * Putting one file's change in a form the window shows without choking:
 * pictures recognised, binary content found the way git finds it, a patch
 * cut to its first lines, and bytes compared row by row.
 */

import { describe, it, expect } from 'vitest';

import { firstLines, hexComparison, imageMediaType, isBinary, MAX_HEX_ROWS } from '../file-changes';

describe('imageMediaType', () => {
  it('names the pictures shown as pictures, whatever the case of their extension', () => {
    expect(imageMediaType('/p/a.PNG')).toBe('image/png');
    expect(imageMediaType('/p/a.jpeg')).toBe('image/jpeg');
    expect(imageMediaType('/p/icon.svg')).toBe('image/svg+xml');
    expect(imageMediaType('/p/notes.txt')).toBeNull();
    expect(imageMediaType('/p/Makefile')).toBeNull();
  });
});

describe('isBinary', () => {
  it('is a NUL byte in the start of the content, as git decides it', () => {
    expect(isBinary(Buffer.from('plain text\n'))).toBe(false);
    expect(isBinary(Buffer.from([0x41, 0, 0x42]))).toBe(true);
    expect(isBinary(Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0])]))).toBe(false);
    expect(isBinary(null)).toBe(false);
  });
});

describe('firstLines', () => {
  it('keeps a patch shorter than the limit whole', () => {
    expect(firstLines('a\nb', 5)).toEqual({ text: 'a\nb', lines: 2, cut: false });
  });

  it('cuts a longer one after its first lines', () => {
    expect(firstLines('a\nb\nc\nd', 2)).toEqual({ text: 'a\nb', lines: 2, cut: true });
  });
});

describe('hexComparison', () => {
  const bytes = (length: number, fill = 0) => Buffer.alloc(length, fill);

  it('shows the rows that differ with a row of context, and counts the rest', () => {
    const before = bytes(16 * 10);
    const after = Buffer.from(before);
    after[16 * 5 + 3] = 0x7f;

    const { rows, truncated } = hexComparison(before, after);

    expect(truncated).toBe(false);
    expect(rows.map((row) => ('skipped' in row ? `skip ${row.skipped}` : row.offset))).toEqual(['skip 4', 64, 80, 96, 'skip 3']);
    const changed = rows[2] as { before: string[]; after: string[] };
    expect(changed.before[3]).toBe('00');
    expect(changed.after[3]).toBe('7f');
  });

  it('shows rows only one side has, past the end of the other', () => {
    const { rows } = hexComparison(bytes(16), bytes(20));

    expect(rows).toEqual([
      { offset: 0, before: Array(16).fill('00'), after: Array(16).fill('00') },
      { offset: 16, before: null, after: ['00', '00', '00', '00'] },
    ]);
  });

  it('shows a file that did not exist before as all after', () => {
    expect(hexComparison(null, Buffer.from([1, 2]))).toEqual({
      rows: [{ offset: 0, before: null, after: ['01', '02'] }],
      truncated: false,
    });
  });

  it('stops at its row limit, and says so', () => {
    const { rows, truncated } = hexComparison(bytes(16 * 1000, 0), bytes(16 * 1000, 1));

    expect(truncated).toBe(true);
    expect(rows).toHaveLength(MAX_HEX_ROWS);
  });

  it('is no row at all for two identical files', () => {
    expect(hexComparison(bytes(64), bytes(64))).toEqual({ rows: [], truncated: false });
  });
});
