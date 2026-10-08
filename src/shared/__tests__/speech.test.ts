import { describe, it, expect } from 'vitest';

import {
  DEFAULT_WHISPER_MODEL,
  GGML_FILE_MAGIC,
  isGgmlMagic,
  isWhisperModelId,
  WHISPER_AUTO_LANGUAGE,
  WHISPER_MODELS,
  WHISPER_SAMPLE_RATE,
  whisperModel,
  whisperModelFileName,
  whisperModelUrl,
} from '../speech';

describe('WHISPER_MODELS', () => {
  it('offers a unique id per entry', () => {
    const ids = WHISPER_MODELS.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is ordered smallest first', () => {
    const sizes = WHISPER_MODELS.map(m => m.approxBytes);
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
  });

  it('stops short of the multi-gigabyte models', () => {
    // medium is 1.5GB and large-v3 is 3GB — not a reasonable first-use
    // download for a dictation box, so the catalogue deliberately ends at
    // small. This guards against someone adding one without thinking.
    for (const model of WHISPER_MODELS) {
      expect(model.approxBytes).toBeLessThan(600 * 1024 * 1024);
    }
  });

  it('marks the English-only variants and only those', () => {
    for (const model of WHISPER_MODELS) {
      expect(model.englishOnly).toBe(model.id.endsWith('.en'));
    }
  });

  it('describes every entry for the settings UI', () => {
    for (const model of WHISPER_MODELS) {
      expect(model.label).toBeTruthy();
      expect(model.description).toBeTruthy();
    }
  });
});

describe('isWhisperModelId', () => {
  it('accepts every catalogued id', () => {
    for (const model of WHISPER_MODELS) {
      expect(isWhisperModelId(model.id)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    // 'large-v3' is a real upstream model but not one this app offers; it
    // must not slip through a stored config.
    expect(isWhisperModelId('large-v3')).toBe(false);
    expect(isWhisperModelId('medium')).toBe(false);
    expect(isWhisperModelId('')).toBe(false);
    expect(isWhisperModelId(undefined)).toBe(false);
    expect(isWhisperModelId(42)).toBe(false);
  });
});

describe('whisperModel', () => {
  it('resolves a catalogued id', () => {
    expect(whisperModel('base.en')?.label).toBe('Base (English)');
  });
});

describe('file names and URLs', () => {
  it('uses the names upstream publishes', () => {
    // whisper.cpp's own download-ggml-model.sh fetches these exact names, so
    // the local cache and the remote file agree.
    expect(whisperModelFileName('base.en')).toBe('ggml-base.en.bin');
    expect(whisperModelFileName('tiny')).toBe('ggml-tiny.bin');
  });

  it('builds a Hugging Face URL ending in the same file name', () => {
    for (const model of WHISPER_MODELS) {
      const url = whisperModelUrl(model.id);
      expect(url).toMatch(/^https:\/\/huggingface\.co\//);
      expect(url.endsWith(whisperModelFileName(model.id))).toBe(true);
    }
  });
});

describe('constants', () => {
  it('defaults to a model that exists in the catalogue', () => {
    expect(isWhisperModelId(DEFAULT_WHISPER_MODEL)).toBe(true);
  });

  it('targets the sample rate whisper.cpp works at', () => {
    // WHISPER_SAMPLE_RATE in whisper.h.
    expect(WHISPER_SAMPLE_RATE).toBe(16000);
  });

  it("uses the binary's own word for language detection", () => {
    // whisper-cli takes -l auto; any other spelling is treated as a language.
    expect(WHISPER_AUTO_LANGUAGE).toBe('auto');
  });

  it('matches the GGML magic number', () => {
    expect(GGML_FILE_MAGIC).toBe(0x67676d6c);
  });
});

describe('isGgmlMagic', () => {
  /**
   * The first bytes of a real ggml-base.en.bin from Hugging Face, read with
   * `curl -r 0-7`. They are `6c 6d 67 67` — "lmgg" — because the magic is a
   * little-endian uint32. An earlier version of this check compared the
   * leading bytes to the text "ggml" and so rejected every valid model file,
   * reporting it as a server error.
   */
  const REAL_MODEL_HEAD = Buffer.from([0x6c, 0x6d, 0x67, 0x67, 0x98, 0xca, 0x00, 0x00]);

  it('accepts the leading bytes of a real model file', () => {
    expect(isGgmlMagic(REAL_MODEL_HEAD)).toBe(true);
  });

  it('accepts exactly four bytes', () => {
    expect(isGgmlMagic(REAL_MODEL_HEAD.subarray(0, 4))).toBe(true);
  });

  it('rejects the ASCII spelling of the magic', () => {
    // This is the mistake being guarded against: "ggml" as text is the
    // byte-reversed form and is not what a model file starts with.
    expect(isGgmlMagic(Buffer.from('ggml', 'ascii'))).toBe(false);
  });

  it('rejects an HTML error page', () => {
    // The failure the check actually exists for: a 200 carrying HTML.
    expect(isGgmlMagic(Buffer.from('<!DOCTYPE html>', 'ascii'))).toBe(false);
  });

  it('rejects a truncated or empty read', () => {
    expect(isGgmlMagic(Buffer.from([0x6c, 0x6d, 0x67]))).toBe(false);
    expect(isGgmlMagic(Buffer.alloc(0))).toBe(false);
  });
});
