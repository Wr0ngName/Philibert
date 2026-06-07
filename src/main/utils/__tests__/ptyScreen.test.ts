import { describe, it, expect } from 'vitest';

import { renderPtyScreen } from '../ptyScreen';

describe('renderPtyScreen', () => {
  it('returns empty string for empty input', () => {
    expect(renderPtyScreen('')).toBe('');
  });

  it('renders plain text without escape sequences', () => {
    expect(renderPtyScreen('hello world')).toBe('hello world');
  });

  it('handles cursor positioning (CSI H)', () => {
    // Write "AB" at row 1, then position to row 2 col 3 and write "CD"
    const raw = 'AB\x1b[2;3HCD';
    const result = renderPtyScreen(raw);
    expect(result).toContain('AB');
    expect(result).toContain('  CD');
  });

  it('handles carriage return', () => {
    expect(renderPtyScreen('hello\rworld')).toBe('world');
  });

  it('handles backspace overwrite', () => {
    // Write 'abc', backspace, write 'X' → 'abX'
    expect(renderPtyScreen('abc\x08X')).toBe('abX');
  });

  it('preserves characters skipped by cursor-forward (ESC[1C)', () => {
    // First write "hello" at a position, then reposition and write
    // around it using cursor-forward to skip existing chars.
    // Row 1: "hello"
    // Then reposition to row 1 col 1, write "H", skip 3 with ESC[3C, write "O"
    // Result: "Hello" with middle chars preserved, last char overwritten
    const raw = 'hello\x1b[1;1HH\x1b[3CO';
    const result = renderPtyScreen(raw);
    expect(result).toBe('HellO');
  });

  it('handles erase line (ESC[K) then rewrite', () => {
    const raw = 'old text\x1b[1;1H\x1b[Knew text';
    expect(renderPtyScreen(raw)).toBe('new text');
  });

  it('handles erase display (ESC[2J)', () => {
    const raw = 'old\x1b[2J\x1b[1;1Hnew';
    expect(renderPtyScreen(raw)).toBe('new');
  });

  it('strips SGR color sequences without affecting content', () => {
    const raw = '\x1b[31mred\x1b[0m normal';
    expect(renderPtyScreen(raw)).toBe('red normal');
  });

  it('strips OSC sequences', () => {
    const raw = '\x1b]0;window title\x07hello';
    expect(renderPtyScreen(raw)).toBe('hello');
  });

  // =========================================================================
  // Real-world OAuth token extraction scenario
  // =========================================================================

  it('recovers cursor-forward-skipped "o" in OAuth token (real-world PTY pattern)', () => {
    // Simulates the exact Ink rendering pattern observed in production:
    // 1. "Paste code here" is rendered on row 3 starting at col 2
    //    → the 'o' in "code" lands at col 9
    // 2. Screen is NOT cleared between frames (Ink uses differential rendering)
    // 3. Token "sk-ant-oat01-..." is rendered on the SAME row 3 at col 2
    //    → Ink sees 'o' is already at col 9, uses ESC[1C to skip it
    //    → Raw output has: sk-ant- ESC[1C at01-...
    // 4. Screen buffer retains the 'o' from step 1

    const raw =
      // Frame 1: "Paste code here" at row 3, col 2
      '\x1b[3;2HPaste\x1b[1Ccode\x1b[1Chere' +
      // Frame 2: token at row 3, col 2 — Ink skips the 'o' at col 9
      '\x1b[3;2Hsk-ant-\x1b[1Cat01-AAAA';

    const rendered = renderPtyScreen(raw);
    // The 'o' at col 9 was written by "code" in frame 1, preserved by cursor-forward
    expect(rendered).toContain('sk-ant-oat01-AAAA');
  });

  it('recovers token when "Paste code here if prompted>" precedes on same row', () => {
    // More realistic: uses ESC[1C for word spacing like the real CLI
    const raw =
      // Prompt at row 23, col 2
      '\x1b[23;2HPaste\x1b[1Ccode\x1b[1Chere\x1b[1Cif\x1b[1Cprompted>' +
      // Erase from col 2 onward on row 23, then write token
      // NOTE: The real CLI does NOT erase — Ink uses differential rendering
      // So we just reposition and write, skipping unchanged chars
      '\x1b[23;2Hsk-ant-\x1b[1Cat01-TestTokenBody1234567890';

    const rendered = renderPtyScreen(raw);
    expect(rendered).toContain('sk-ant-oat01-TestTokenBody1234567890');
  });

  it('handles the full CLI output pattern with cursor positioning and spinner', () => {
    // Simplified version of real PTY output:
    // 1. Clear screen
    // 2. Welcome message
    // 3. "Opening browser..." with spinner
    // 4. "Paste code here if prompted>" on row 22
    // 5. Success message + token on row 22 (reusing same row)
    const tokenBody = 'XAt2gbKqdOfN8oHgKzkuJbK97kjTCVTk-dXijxl-qazzkyuj5dK5vrrLfQYpJPkPXIhKd5p610u5mbjBdz9pTg-wyuk6AA_';
    const raw =
      '\x1b[2J' +                                    // Clear screen
      '\x1b[1;1HWelcome to Claude Code' +             // Welcome
      '\x1b[5;2HPaste\x1b[1Ccode\x1b[1Chere' +       // "Paste code here" at row 5
      '\x1b[5;2Hsk-ant-\x1b[1Cat01-' + tokenBody +   // Token at same row 5
      '\x1b[7;2HStore this token';                    // Next line

    const rendered = renderPtyScreen(raw);
    const expectedToken = 'sk-ant-oat01-' + tokenBody;
    expect(rendered).toContain(expectedToken);
  });

  it('works correctly when there is NO previous char at the cursor-forward position', () => {
    // If cursor-forward skips a position that was never written to,
    // the screen buffer has nothing there → space in output
    const raw = '\x1b[1;1Hsk-ant-\x1b[1Cat01-body';
    const rendered = renderPtyScreen(raw);
    // No previous char at col 9, so it's a space
    expect(rendered).toContain('sk-ant- at01-body');
  });
});
