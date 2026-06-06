/**
 * Real-world stripAnsi coverage: byte patterns observed in actual Claude Code
 * CLI v2.1.150 PTY output, plus adversarial / stress cases.
 *
 * These tests exist because the OAuth-token-extraction path is CRITICAL —
 * a single dropped byte corrupts the token and burns a fresh OAuth session
 * for the user. The unit tests in ansi.test.ts cover named pattern classes;
 * this file covers concrete observed-in-production byte sequences and
 * stress / boundary conditions.
 */
import { describe, it, expect } from 'vitest';

import { stripAnsi, hasAnsi } from '../ansi';

describe('stripAnsi real-world byte patterns', () => {
  describe('CLI v2.1.150 spinner animation (observed in chunks #10-#27)', () => {
    // Each spinner frame: 0x08 (BS) + UTF-8 glyph
    const FRAMES = ['*', '✶', '✻', '✽', '✻', '✶'];

    it('reduces a multi-frame spinner to its final visible glyph', () => {
      // Reconstructs the exact chunk pattern: BS+glyph BS+glyph BS+glyph ...
      // Glyphs are non-alphanumeric so the overwrite-strip applies cleanly.
      const start = '*'; // initial visible char
      const animation = FRAMES.slice(1).map(g => `\b${g}`).join('');
      const cleaned = stripAnsi(start + animation);
      expect(cleaned).toBe(FRAMES[FRAMES.length - 1]);
    });

    it('handles spinner followed by data without losing the data', () => {
      const spinner = '*\b✶\b✻\b✽';
      const data = 'Success!';
      // Final spinner glyph (✽) followed by \b then data: ✽\b removes both,
      // data survives.
      expect(stripAnsi(spinner + '\b' + data)).toBe(data);
    });
  });

  describe('OAuth token rendering: real chunk #32 shape', () => {
    // What the CLI actually emits around the token (reconstructed from
    // kotik's logs + the byte-level diagnosis):
    //   ESC[18;2H ESC[K \n ✓ ESC[1C "Long-lived" ESC[1C ... ! ESC[20;2H ESC[K
    //   \n "Your" ESC[1C "OAuth" ... ESC[20;2H ESC[K \n
    //   "sk-ant-" "o" BS "at01-<rest>" \n
    const TOKEN_BODY = 'oat01-' + 'M'.repeat(89); // 95 chars after sk-ant-
    const FULL_TOKEN = 'sk-ant-' + TOKEN_BODY;
    const realChunk = [
      '\x1b[18;2H\x1b[K\n✓\x1b[1CLong-lived\x1b[1Cauthentication\x1b[1Ctoken',
      '\x1b[1Ccreated\x1b[1Csuccessfully!',
      '\x1b[20;2H\x1b[K\nYour\x1b[1COAuth\x1b[1Ctoken\x1b[1C(valid\x1b[1Cfor\x1b[1C1\x1b[1Cyear):',
      '\x1b[22;2H\x1b[K\nsk-ant-' + TOKEN_BODY.charAt(0) + '\b' + TOKEN_BODY.slice(1),
      '\x1b[24;2H\x1b[K\nStore\x1b[1Cthis\x1b[1Ctoken\x1b[1Csecurely.',
    ].join('');

    it('cleans the realistic chunk such that the token survives verbatim', () => {
      const clean = stripAnsi(realChunk);
      expect(clean).toContain(FULL_TOKEN);
    });

    it('extraction regex captures the full token from the cleaned realistic chunk', () => {
      const clean = stripAnsi(realChunk);
      const m = clean.match(/(sk-ant-[A-Za-z0-9_-]+)/);
      expect(m?.[1]).toBe(FULL_TOKEN);
      expect(m?.[1].length).toBe(FULL_TOKEN.length);
    });
  });

  describe('Tokens wrapped in styling escapes', () => {
    const TOKEN = 'sk-ant-oat01-' + 'A'.repeat(95);

    it('survives SGR bold around the whole token', () => {
      expect(stripAnsi(`\x1b[1m${TOKEN}\x1b[0m`)).toContain(TOKEN);
    });

    it('survives per-character SGR styling within the token', () => {
      // Worst-case: every char wrapped individually.
      const styled = [...TOKEN].map(c => `\x1b[1m${c}\x1b[0m`).join('');
      expect(stripAnsi(styled)).toBe(TOKEN);
    });

    it('survives 256-color SGR (multi-param CSI)', () => {
      expect(stripAnsi(`\x1b[38;5;208m${TOKEN}\x1b[39m`)).toContain(TOKEN);
    });

    it('survives RGB true-color SGR', () => {
      expect(stripAnsi(`\x1b[38;2;255;128;0m${TOKEN}\x1b[0m`)).toContain(TOKEN);
    });

    it('survives OSC hyperlink wrap', () => {
      // OSC 8 hyperlink: \x1b]8;;<url>\x1b\\<text>\x1b]8;;\x1b\\
      const hyperlinked = `\x1b]8;;https://anthropic.com\x1b\\${TOKEN}\x1b]8;;\x1b\\`;
      expect(stripAnsi(hyperlinked)).toBe(TOKEN);
    });
  });

  describe('Tokens with backspace patterns', () => {
    const TAIL = 'at01-' + 'X'.repeat(90);
    const TOKEN = 'sk-ant-o' + TAIL;

    it('preserves leading o when CLI uses BS animation (kotik v0.17.27 case)', () => {
      const clean = stripAnsi(`sk-ant-o\b${TAIL}`);
      expect(clean).toContain(TOKEN);
    });

    it('preserves token when BS appears mid-token between alphanumerics', () => {
      // Mid-token: 'sk-ant-oat0' BS '1-...'
      const split = TOKEN.slice(0, 11) + '\b' + TOKEN.slice(11);
      const clean = stripAnsi(split);
      // The standalone BS gets stripped by stripAnsi's BACKSPACE pass; result
      // contains all data chars.
      expect(clean).toContain(TOKEN);
    });

    it('preserves token across multiple BS-animation passes', () => {
      // Triple animation: spinner replaced then data char prepended via BS
      const wonky = `sk-ant-*\b✶\bo${TAIL}`;
      const clean = stripAnsi(wonky);
      expect(clean).toContain(TOKEN);
    });
  });

  describe('Adversarial inputs', () => {
    it('handles empty string', () => {
      expect(stripAnsi('')).toBe('');
    });

    it('handles only ESC bytes', () => {
      expect(stripAnsi('\x1b\x1b\x1b')).toBe('');
    });

    it('handles only backspaces', () => {
      expect(stripAnsi('\b\b\b')).toBe('');
    });

    it('handles unterminated CSI at end of buffer', () => {
      // `\x1b[` with no terminator. Our CSI regex requires a final byte;
      // unterminated CSI falls through to LONE_ESC which strips only `\x1b`,
      // leaving `[` as data. Cosmetically lossy but no data destruction.
      expect(stripAnsi('hello\x1b[')).toBe('hello[');
    });

    it('handles unterminated OSC at end of buffer', () => {
      // `\x1b]0;Title` with no BEL/ST. Falls through similarly: ESC stripped,
      // payload leaked. Cosmetic only.
      expect(stripAnsi('hello\x1b]0;Title')).toBe('hello]0;Title');
    });

    it('handles deeply nested escapes', () => {
      const input = '\x1b[1m\x1b[2m\x1b[3m\x1b[4mtext\x1b[0m\x1b[0m\x1b[0m\x1b[0m';
      expect(stripAnsi(input)).toBe('text');
    });

    it('is idempotent: stripAnsi(stripAnsi(x)) === stripAnsi(x)', () => {
      const inputs = [
        '\x1b[31mhello\x1b[0m',
        'sk-ant-o\bat01-XYZ',
        '\x1b]0;title\x07data',
        '*\b✶\bDone',
      ];
      for (const input of inputs) {
        const once = stripAnsi(input);
        expect(stripAnsi(once)).toBe(once);
      }
    });

    it('treats raw text without escapes as a no-op', () => {
      const plain = 'plain ASCII text\nwith newlines\tand tabs';
      expect(stripAnsi(plain)).toBe(plain);
    });

    it('handles 100KB input without choking', () => {
      const big = 'a'.repeat(50_000) + '\x1b[31m' + 'b'.repeat(50_000) + '\x1b[0m';
      const start = Date.now();
      const clean = stripAnsi(big);
      const elapsed = Date.now() - start;
      expect(clean.length).toBe(100_000);
      expect(elapsed).toBeLessThan(1000); // sanity bound, should be <50ms
    });

    it('handles malicious BS run that targets every other char', () => {
      // Aimed at trying to confuse the BACKSPACE_OVERWRITE loop.
      const input = 'a\bb\bc\bd\be\bf';
      // All chars are alphanumeric → none consumed by overwrite. Standalone
      // BSs stripped. Result: all six chars survive.
      expect(stripAnsi(input)).toBe('abcdef');
    });

    it('handles all-spinner glyph BS chain (non-data)', () => {
      const input = '*\b/\b\\\b|\b*';
      // All glyphs non-data → cleanly resolves to last glyph.
      expect(stripAnsi(input)).toBe('*');
    });

    it('does not consume a newline that follows BS', () => {
      expect(stripAnsi('hello\n\bworld')).toBe('hello\nworld');
    });
  });

  describe('Cross-pattern composition', () => {
    it('CSI inside BS-overwrite sequence', () => {
      // *\bSGR-styled-token still resolves cleanly: BS_OVERWRITE handles *\b,
      // SGR strips around the data.
      const TOKEN = 'sk-ant-oat01-' + 'X'.repeat(95);
      expect(stripAnsi(`*\b\x1b[1m${TOKEN}\x1b[0m`)).toBe(TOKEN);
    });

    it('OSC + lone ESC + BS in one buffer', () => {
      const input = '\x1b]0;Title\x07\x1bxhello\b\x1b';
      // OSC stripped, lone ESC stripped, 'o\b' wait — `x` is alpha so 'x\b'
      // does NOT match the new BACKSPACE_OVERWRITE. Standalone BS stripped.
      // Wait: 'x' is the char after \x1b — but \x1b is stripped first, leaving
      // 'xhello\b'. Then 'o\b' — 'o' is alpha → not consumed. BS stripped.
      // Result: 'xhello'.
      expect(stripAnsi(input)).toBe('xhello');
    });

    it('chunked sequential escapes do not corrupt token across them', () => {
      // Simulates two chunks that, when concatenated, contain a token split
      // by an ANSI sequence.
      const TOKEN_PART_1 = 'sk-ant-oat01-AAAAA';
      const TOKEN_PART_2 = 'BBBBBccccc';
      const FULL = TOKEN_PART_1 + TOKEN_PART_2;
      const buffer = TOKEN_PART_1 + '\x1b[1m\x1b[0m' + TOKEN_PART_2;
      expect(stripAnsi(buffer)).toBe(FULL);
    });
  });
});

describe('hasAnsi real-world', () => {
  it('detects BS sequences via lone ESC fallback? — no, BS alone returns false', () => {
    // hasAnsi only checks ESC-based escapes, not BS. That's by design — BS
    // is a control char but not strictly an "ANSI escape." Document it.
    expect(hasAnsi('plain\bdata')).toBe(false);
  });

  it('detects nested SGR', () => {
    expect(hasAnsi('\x1b[1m\x1b[31mred\x1b[0m\x1b[0m')).toBe(true);
  });

  it('does not flag normal ASCII as containing ANSI', () => {
    expect(hasAnsi('the quick brown fox jumps over the lazy dog 0123456789')).toBe(false);
  });

  it('handles invocation in tight loops (no lastIndex leak)', () => {
    // The pre-fix hasAnsi used .test() on /g-flagged regexes which leaked
    // lastIndex between calls. Regression test: call repeatedly on the same
    // string and assert consistent results.
    const sample = '\x1b[31mred\x1b[0m';
    for (let i = 0; i < 100; i++) {
      expect(hasAnsi(sample)).toBe(true);
    }
  });
});
