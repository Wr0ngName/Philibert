import { describe, it, expect } from 'vitest';

import { stripAnsi, hasAnsi } from '../ansi';

describe('stripAnsi', () => {
  describe('CSI sequences', () => {
    it('strips SGR color codes', () => {
      expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    });

    it('strips SGR styling (bold/dim/italic)', () => {
      expect(stripAnsi('\x1b[1mBOLD\x1b[22m \x1b[3mitalic\x1b[23m')).toBe('BOLD italic');
    });

    it('strips cursor-right CSI entirely (used by some CLIs for spaces)', () => {
      expect(stripAnsi('Hello\x1b[1CWorld')).toBe('HelloWorld');
    });

    it('replaces cursor-positioning CSI with newline to preserve word boundaries', () => {
      expect(stripAnsi('Line1\x1b[5;1HLine2')).toBe('Line1\nLine2');
    });

    it('replaces erase-line CSI with newline', () => {
      expect(stripAnsi('header\x1b[Ktail')).toBe('header\ntail');
    });
  });

  describe('OSC sequences', () => {
    it('strips OSC window title (BEL-terminated)', () => {
      expect(stripAnsi('\x1b]0;Window Title\x07after')).toBe('after');
    });

    it('strips OSC hyperlink (ST-terminated)', () => {
      expect(stripAnsi('\x1b]8;;https://x.example\x1b\\link\x1b]8;;\x1b\\post')).toBe('linkpost');
    });
  });

  describe('DCS / SOS / PM / APC', () => {
    it('strips DCS sequences', () => {
      expect(stripAnsi('before\x1bPq\x1b\\after')).toBe('beforeafter');
    });
  });

  describe('Lone ESC bytes (v2.1.150 regression)', () => {
    // Background: the Claude Code CLI v2.1.150 emits a stray ESC byte (\x1b)
    // immediately before printing the OAuth token line. Historically the
    // SINGLE pattern (/\x1b./g) ate both the ESC *and* the following byte —
    // which was the leading 'o' of the token's `oat01-` prefix, corrupting
    // every captured token. Standard 2-byte escapes have alphanumeric finals
    // (D, E, H, M, N, O, c, n, o, Z, 7, 8, …) that collide with data bytes,
    // so eating the byte after ESC is unsafe. Strip the ESC alone instead.

    it('strips lone ESC without consuming the next alphanumeric byte', () => {
      expect(stripAnsi('sk-ant-\x1boat01-XYZ')).toBe('sk-ant-oat01-XYZ');
    });

    it('preserves data bytes when ESC precedes a digit', () => {
      expect(stripAnsi('value=\x1b7abc')).toBe('value=7abc');
    });

    it('preserves data bytes when ESC precedes an uppercase letter', () => {
      expect(stripAnsi('prefix\x1bDtoken')).toBe('prefixDtoken');
    });

    it('handles multiple lone ESCs without eating intervening data', () => {
      expect(stripAnsi('a\x1bbc\x1bde\x1bf')).toBe('abcdef');
    });

    it('strips trailing lone ESC at end of buffer', () => {
      expect(stripAnsi('hello\x1b')).toBe('hello');
    });

    it('preserves a full OAuth token shape across embedded escapes', () => {
      const realToken = 'sk-ant-oat01-' + 'A'.repeat(95);
      const noisy = `Your token:\n\x1b${realToken}\nStore this`;
      const clean = stripAnsi(noisy);
      expect(clean).toContain(realToken);
    });
  });

  describe('Backspace handling (spinner animations)', () => {
    it('removes backspace + previous char', () => {
      expect(stripAnsi('a\bb')).toBe('b');
    });

    it('removes standalone backspace', () => {
      expect(stripAnsi('\bhello')).toBe('hello');
    });

    it('handles repeated overwrites (spinner)', () => {
      // Spinner pattern: each frame writes a char then \b to erase
      expect(stripAnsi('|\b/\b-\b\\\bDone')).toBe('Done');
    });

    it('preserves newlines (does not treat \\n\\b as overwrite)', () => {
      expect(stripAnsi('line1\n\bline2')).toBe('line1\nline2');
    });
  });

  describe('Combinations', () => {
    it('handles mixed CSI + OSC + lone ESC + backspace', () => {
      const input = '\x1b]0;Title\x07\x1b[31mErr\x1b[0m: \x1bofoo\bbar\x1b';
      expect(stripAnsi(input)).toBe('Err: ofobar');
    });

    it('idempotent: stripping already-clean text returns the same text', () => {
      const clean = 'plain ASCII text with newlines\nand tabs\t';
      expect(stripAnsi(clean)).toBe(clean);
    });
  });
});

describe('hasAnsi', () => {
  it('returns true for SGR codes', () => {
    expect(hasAnsi('\x1b[31mred\x1b[0m')).toBe(true);
  });

  it('returns true for OSC sequences', () => {
    expect(hasAnsi('\x1b]0;title\x07')).toBe(true);
  });

  it('returns true for lone ESC bytes', () => {
    expect(hasAnsi('plain\x1bdata')).toBe(true);
  });

  it('returns false for clean ASCII', () => {
    expect(hasAnsi('just plain text')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(hasAnsi('')).toBe(false);
  });
});
