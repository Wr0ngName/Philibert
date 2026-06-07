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

  it('ESC[K with no param erases to end of line (mode 0), not from start (mode 1)', () => {
    // Write "abcdef" at row 1 col 1, then position to col 4 and ESC[K
    // Should erase cols 4-6, preserving "abc"
    const raw = 'abcdef\x1b[1;4H\x1b[K';
    expect(renderPtyScreen(raw)).toBe('abc');
  });

  it('ESC[0K erases from cursor to end of line', () => {
    const raw = 'abcdef\x1b[1;4H\x1b[0K';
    expect(renderPtyScreen(raw)).toBe('abc');
  });

  it('ESC[1K erases from start of line to cursor (inclusive)', () => {
    const raw = 'abcdef\x1b[1;4H\x1b[1K';
    expect(renderPtyScreen(raw)).toBe('    ef');
  });

  it('preserves col 9 char through ESC[K erase-to-end at col 32 (production scenario)', () => {
    // Simulates: "Paste code here" at row 5, password masking at col 32,
    // ESC[K to clear password, then token written skipping col 9
    const raw =
      '\x1b[5;2HPaste\x1b[1Ccode\x1b[1Chere' +   // 'o' at col 9
      '\x1b[5;32H*****\x1b[5;32H\x1b[K' +         // password at col 32, then ESC[K clears it
      '\x1b[5;2Hsk-ant-\x1b[1Cat01-BODY';          // token, skipping col 9
    const rendered = renderPtyScreen(raw);
    expect(rendered).toContain('sk-ant-oat01-BODY');
  });

  it('recovers token from production hex data', () => {
    const hex = '1b5b3f39303031681b5b3f31303034681b5b3f32356c1b5b324a1b5b6d1b5b481b5d303b636c61756465071b5b3f3235681b5b3f32303034681b5b3f31303034681b5b3f32303331681b5b3f32356c57656c636f6d651b5b3143746f1b5b3143436c617564651b5b3143436f64651b5b314376322e312e3135300d0a2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e1b5b343b36482a1b5b333943e29688e29688e29688e29688e29688e29693e29693e296911b5b353b3334482a1b5b3943e29688e29688e29688e29693e296911b5b3543e29691e296911b5b363b313348e29691e29691e29691e29691e29691e296911b5b323443e29688e29688e29688e29693e296911b5b373b3548e29691e29691e296911b5b3343e29691e29691e29691e29691e29691e29691e29691e29691e29691e296911b5b323243e29688e29688e29688e29693e296911b5b383b3448e29691e29691e29691e29691e29691e29691e29691e29691e29691e29691e29691e29691e29691e29691e29691e29691e29691e29691e296911b5b34432a1b5b313643e29688e29688e29693e29691e296911b5b3643e296931b5b393b343648e29691e29693e29693e29688e29688e29688e29693e29693e296911b5b31303b32482a1b5b333343e29691e29691e29691e296911b5b31313b333448e29691e29691e29691e29691e29691e29691e29691e296911b5b31323b333248e29691e29691e29691e29691e29691e29691e29691e29691e29691e29691e29691e29691e29691e29691e29691e296911b5b31333b3848e29688e29688e29688e29688e29688e29688e29688e29688e296881b5b3430432a1b5b31343b3748e29688e29688e29684e29688e29688e29688e29688e29688e29684e29688e296881b5b3234432a1b5b31353b3848e29688e29688e29688e29688e29688e29688e29688e29688e296881b5b36432a0d0a2e2e2e2e2e2e2ee296881b5b3143e296881b5b3343e296881b5b3143e296882e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e1b5b3e30711b5b31383b3248c2b71b5b31434f70656e696e671b5b314362726f777365721b5b3143746f1b5b31437369676e1b5b3143696ee280a61b5b31383b3248e29ca2082a08e29cb608e29cbb08e29cbd08e29cbb08e29cb6082a08e29ca208c2b708e29ca2082a08e29cbb08e29cbd08e29cbb08e29cb6082a08e29ca208c2b70842726f77736572206469646e2774206f70656e3f1b5b3143557365207468652075726c1b5b314362656c6f771b5b3143746f1b5b31437369676e1b5b3143696e1b5b314328631b5b3143746f1b5b3143636f7079291b5b32303b314868747470733a2f2f636c617564652e636f6d2f6361692f6f617574682f617574686f72697a653f636f64653d7472756526636c69656e745f69643d39643163323530612d653631622d343464392d383865642d35393434643139363266356526726573706f6e73655f747970653d636f64652672656469726563745f7572693d6874747073253341253246253246706c6174666f726d2e636c617564652e636f6d2532466f61757468253246636f646525324663616c6c6261636b2673636f70653d75736572253341696e666572656e636526636f64655f6368616c6c656e67653d4d334f65793034656b58734f672d5f4d566d4f445f4f33657353696b385556667a706475545a437849334926636f64655f6368616c6c656e67655f6d6574686f643d533235362673746174653d564a2d686b636654794b77447638615f7734654350674c424c393943756c726966535231634c523236744d1b5b32333b324850617374651b5b3143636f64651b5b3143686572651b5b314369661b5b314370726f6d707465641b5b31433e1b5b32303b3148201b5b333434431b5b4b1b5b32333b33324835082a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a4c523236744d1b5b32333b3332481b5b4b1b5b343639431b5b31383b32481b5b4b0ae29c931b5b31434c6f6e672d6c697665641b5b314361757468656e7469636174696f6e1b5b3143746f6b656e1b5b3143637265617465641b5b31437375636365737366756c6c79211b5b32303b32481b5b4b0a596f75721b5b31434f417574681b5b3143746f6b656e1b5b31432876616c69641b5b3143666f721b5b3143311b5b314379656172293a1b5b32333b3248736b2d616e742d1b5b3143617430312d6a586245686442694b676b52766c76736b624958763275664d4647746958747a666b77587a6552445357436a346f6a356d4978686d62754633745a786c6659594e75484f72665f5273374558316773713465416243772d424f7974644141411b5b32353b324853746f72651b5b3143746869731b5b3143746f6b656e1b5b31437365637572656c792e1b5b3143596f751b5b3143776f6e27741b5b314362651b5b314361626c651b5b3143746f1b5b31437365651b5b314369741b5b3143616761696e2e1b5b32373b32485573651b5b3143746869731b5b3143746f6b656e1b5b314362791b5b314373657474696e673a1b5b31436578706f72741b5b3143434c415544455f434f44455f4f415554485f544f4b454e3d3c746f6b656e3e1b5b32393b31481b5b3f3235681b5b3f313030366c1b5b3f313030336c1b5b3f313030326c1b5b3f313030306c1b5b3e346d1b5b3c751b5b3f323033316c1b5b3f323030346c1b5b3e346d1b5b3c751b5b3f323033316c1b5b3f323030346c';
    const raw = Buffer.from(hex, 'hex').toString('utf-8');
    const rendered = renderPtyScreen(raw);
    expect(rendered).toContain('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');
  });
});
