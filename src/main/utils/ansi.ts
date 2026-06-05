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
   * IMPORTANT: strips only the ESC byte itself, never the following byte.
   * Standard 2-byte escapes (e.g. \x1bD IND, \x1bo LS3) have alphanumeric
   * finals that collide with data — the Claude Code CLI v2.1.150 emits a
   * stray \x1b immediately before OAuth tokens, and a greedy `/\x1b./g`
   * would eat the leading 'o' of the `oat01-` prefix, corrupting the token.
   * Leaving an unrecognized 2-byte escape's final byte in the output is
   * cosmetically harmless; eating a data byte is catastrophic.
   */
  LONE_ESC: /\x1b/g,
  /** Backspace characters used by spinners — a char followed by \b overwrites it */
  BACKSPACE_OVERWRITE: /[^\n\x08]\x08/g,
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
