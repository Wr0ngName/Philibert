/**
 * Showing one file's change: deciding whether it is text, a picture or other
 * bytes, and putting it in a form the window can show without choking —
 * a patch cut to a size, two pictures, or the rows of bytes that differ.
 * Pure: the git calls are GitService's.
 */

import path from 'node:path';

import type { HexRow } from '../../../shared/types';

/** The pictures shown as pictures, by extension. */
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

/** The media type of a picture, or null for a file that is not one. */
export function imageMediaType(filePath: string): string | null {
  return IMAGE_TYPES[path.extname(filePath).toLowerCase()] ?? null;
}

/** How far into a file git looks for a NUL byte to call it binary, and so do we. */
const BINARY_SNIFF_BYTES = 8000;

export function isBinary(content: Buffer | null): boolean {
  return !!content && content.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** Most of a patch shown; past it, its start and the size of the whole change. */
export const MAX_PATCH_LINES = 2000;
/** Most of a patch read from git, whatever its lines. */
export const MAX_PATCH_BYTES = 512 * 1024;

/** A patch cut to its first `maxLines` lines, and how many those are. */
export function firstLines(patch: string, maxLines: number): { text: string; lines: number; cut: boolean } {
  let end = -1;
  for (let line = 0; line < maxLines; line += 1) {
    end = patch.indexOf('\n', end + 1);
    if (end === -1) return { text: patch, lines: line + 1, cut: false };
  }
  return { text: patch.slice(0, end), lines: maxLines, cut: true };
}

/** Bytes per row of the hex comparison, as hex editors show them. */
export const HEX_ROW_BYTES = 16;
/** Most rows the hex comparison shows. */
export const MAX_HEX_ROWS = 256;

/** The bytes of a row, or null where the file has none at that offset. */
function rowOf(content: Buffer | null, offset: number): Buffer | null {
  return content && offset < content.length ? content.subarray(offset, offset + HEX_ROW_BYTES) : null;
}

function hexOf(bytes: Buffer | null): string[] | null {
  return bytes ? [...bytes].map((byte) => byte.toString(16).padStart(2, '0')) : null;
}

/**
 * Two versions of a file, compared row by row at the same offsets, as hex
 * comparison tools do: the rows that differ, each with a row of context on
 * either side, identical stretches between them counted rather than shown.
 * Stops at `MAX_HEX_ROWS` rows shown.
 */
export function hexComparison(
  before: Buffer | null,
  after: Buffer | null,
): { rows: Array<HexRow | { skipped: number }>; truncated: boolean } {
  const length = Math.max(before?.length ?? 0, after?.length ?? 0);
  const totalRows = Math.ceil(length / HEX_ROW_BYTES);
  // Raw bytes compared once per row; hex text only for the rows shown.
  const differs = new Uint8Array(totalRows);
  for (let row = 0; row < totalRows; row += 1) {
    const a = rowOf(before, row * HEX_ROW_BYTES);
    const b = rowOf(after, row * HEX_ROW_BYTES);
    differs[row] = a && b && a.equals(b) ? 0 : 1;
  }

  const rows: Array<HexRow | { skipped: number }> = [];
  let shown = 0;
  let skipped = 0;
  for (let row = 0; row < totalRows; row += 1) {
    const near = differs[row] || (row > 0 && differs[row - 1]) || (row + 1 < totalRows && differs[row + 1]);
    if (!near) {
      skipped += 1;
      continue;
    }
    if (shown >= MAX_HEX_ROWS) return { rows, truncated: true };
    if (skipped > 0) {
      rows.push({ skipped });
      skipped = 0;
    }
    const offset = row * HEX_ROW_BYTES;
    rows.push({ offset, before: hexOf(rowOf(before, offset)), after: hexOf(rowOf(after, offset)) });
    shown += 1;
  }
  if (skipped > 0 && rows.length > 0) rows.push({ skipped });
  return { rows, truncated: false };
}
