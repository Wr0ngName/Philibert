import { describe, it, expect } from 'vitest';

import {
  DEFAULT_WHISPER_MODEL,
  GGML_MAGIC,
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

  it('matches the GGML magic bytes', () => {
    expect(GGML_MAGIC).toBe('ggml');
  });
});
