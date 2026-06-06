/**
 * ANSI Escape Code Utilities
 *
 * Functions for handling ANSI escape sequences in terminal output.
 * Extracted from AuthService for reuse across the codebase.
 */

/* eslint-disable no-control-regex */

/**
 * Regular expression patterns for ANSI escape sequences
 */
const ANSI_PATTERNS = {
  /** CSI sequences that imply a line break (cursor positioning, next line, erase line) */
  CSI_LINE_BREAK: /\x1b\[[0-9;?]*[HfEFGd]|\x1b\[[0-9;?]*K/g,
  /** All other CSI (Control Sequence Introducer) sequences */
  CSI: /\x1b\[[0-9;?]*[a-zA-Z]/g,
  /** OSC (Operating System Command) sequences */
  OSC: /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,
  /** DCS, SOS, PM, APC sequences */
  CONTROL: /\x1b[PX^_][^\x1b]*\x1b\\/g,
  /**
   * Lone/stray ESC bytes that aren't part of a structured sequence above.
   *
   * Strips only the ESC byte itself, never the following byte. Standard
   * 2-byte escapes (e.g. \x1bD IND, \x1bo LS3) have alphanumeric finals
   * that overlap with data characters, so a greedy `/\x1b./g` could
   * destroy data if such an escape ever sat next to it. Leaving an
   * unrecognized 2-byte escape's final byte in the output is cosmetically
   * harmless; eating a data byte would be catastrophic.
   */
  LONE_ESC: /\x1b/g,
  /**
   * Spinner-overwrite pattern: an animation glyph followed by \b that erases it.
   *
   * IMPORTANT: we exclude data characters (`[A-Za-z0-9_-]`) from the overwritten
   * position. Claude Code CLI v2.1.150 in PTY mode renders the OAuth token with
   * a backspace animation that emits `sk-ant-o\bat01-…`; the unrestricted rule
   * `/[^\n\x08]\x08/g` happily ate the `o` as if it were a spinner glyph,
   * mangling the captured token to `sk-ant-at01-…` and breaking 401-handling
   * downstream. Animation glyphs are *non*-alphanumeric (`*`, `|`, `/`, `\`,
   * unicode dots/blocks), so excluding the token character class strips real
   * animations without ever destroying token data. The cosmetic cost is that
   * `a\bb` becomes `ab` (instead of `b`) — visually wrong per terminal
   * semantics, but we don't render this string, we parse it.
   */
  BACKSPACE_OVERWRITE: /[^\n\x08A-Za-z0-9_-]\x08/g,
  /** Any remaining standalone backspace characters */
  BACKSPACE: /\x08/g,
} as const;

/**
 * Strip all ANSI escape codes from a string.
 *
 * Handles:
 * - CSI sequences (cursor movement, colors, etc.)
 * - OSC sequences (window titles, hyperlinks)
 * - DCS, SOS, PM, APC control sequences
 * - Single-character escape sequences
 *
 * @param str - The string containing ANSI escape codes
 * @returns The string with all ANSI codes removed
 *
 * @example
 * stripAnsi('\x1b[31mRed Text\x1b[0m') // => 'Red Text'
 * stripAnsi('\x1b]0;Window Title\x07') // => ''
 */
export function stripAnsi(str: string): string {
  let clean = str;
  // CSI sequences that imply line breaks (cursor positioning, erase line) →
  // replace with newline to preserve word boundaries between visual lines.
  // Without this, text on separate terminal lines gets concatenated.
  clean = clean.replace(ANSI_PATTERNS.CSI_LINE_BREAK, '\n');
  // Remaining CSI sequences (colors, styles, etc.)
  clean = clean.replace(ANSI_PATTERNS.CSI, '');
  // OSC sequences
  clean = clean.replace(ANSI_PATTERNS.OSC, '');
  // DCS, SOS, PM, APC
  clean = clean.replace(ANSI_PATTERNS.CONTROL, '');
  // Lone ESC bytes (strips ESC only, never the following data byte)
  clean = clean.replace(ANSI_PATTERNS.LONE_ESC, '');
  // Backspace overwrites (spinner animations: char + \b = erase) — loop until stable
  let prev;
  do {
    prev = clean;
    clean = clean.replace(ANSI_PATTERNS.BACKSPACE_OVERWRITE, '');
  } while (clean !== prev);
  clean = clean.replace(ANSI_PATTERNS.BACKSPACE, '');
  return clean;
}

/**
 * Check if a string contains ANSI escape codes.
 *
 * @param str - The string to check
 * @returns true if the string contains ANSI codes
 */
export function hasAnsi(str: string): boolean {
  // Create fresh non-global copies to avoid lastIndex state leaking across calls
  return (
    /\x1b\[[0-9;?]*[a-zA-Z]/.test(str) ||
    /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.test(str) ||
    /\x1b[PX^_][^\x1b]*\x1b\\/.test(str) ||
    /\x1b/.test(str)
  );
}

/* eslint-enable no-control-regex */
