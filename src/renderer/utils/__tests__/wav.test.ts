/**
 * Audio conversion for speech-to-text.
 *
 * The whisper binary reads 16-bit PCM WAV; the microphone gives stereo float
 * at 44.1 or 48kHz, and MediaRecorder gives WebM/Opus, which the binary cannot
 * decode. These are the conversions in between, and the header has to be
 * exactly right — a wrong byte there fails inside the binary with nothing
 * useful on stderr.
 */

import { describe, it, expect } from 'vitest';

import {
  audioBufferToWav,
  encodeWavPcm16,
  mixToMono,
  resampleMono,
} from '../wav';

/** A stand-in for AudioBuffer, which the test environment does not implement. */
function fakeAudioBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate,
    getChannelData: (i: number) => channels[i],
  } as unknown as AudioBuffer;
}

function ascii(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

describe('mixToMono', () => {
  it('returns the single channel untouched when already mono', () => {
    const mono = new Float32Array([0.1, -0.2, 0.3]);
    expect(mixToMono(fakeAudioBuffer([mono], 16000))).toBe(mono);
  });

  it('averages channels rather than taking the first', () => {
    // Taking channel 0 would lose a voice recorded mostly on the right.
    const left = new Float32Array([0, 0, 0]);
    const right = new Float32Array([1, 0.5, -1]);
    const mixed = mixToMono(fakeAudioBuffer([left, right], 16000));
    expect(Array.from(mixed)).toEqual([0.5, 0.25, -0.5]);
  });
});

describe('resampleMono', () => {
  it('returns the input untouched when the rates match', () => {
    const samples = new Float32Array([0.1, 0.2]);
    expect(resampleMono(samples, 16000, 16000)).toBe(samples);
  });

  it('shortens the signal when downsampling', () => {
    const samples = new Float32Array(48000).fill(0.5);
    const out = resampleMono(samples, 48000, 16000);
    expect(out.length).toBe(16000);
  });

  it('preserves a constant signal through resampling', () => {
    // Interpolation between equal neighbours must not drift.
    const samples = new Float32Array(900).fill(0.25);
    const out = resampleMono(samples, 45000, 15000);
    for (const sample of out) expect(sample).toBeCloseTo(0.25, 6);
  });

  it('interpolates between neighbours rather than dropping samples', () => {
    // 4 samples at 4Hz -> 16Hz asks for values between the originals.
    const out = resampleMono(new Float32Array([0, 1]), 2, 4);
    expect(out.length).toBe(4);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
  });

  it('handles an empty buffer', () => {
    expect(resampleMono(new Float32Array(0), 48000, 16000).length).toBe(0);
  });

  it('rejects a nonsensical rate', () => {
    expect(() => resampleMono(new Float32Array([1]), 0, 16000)).toThrow();
    expect(() => resampleMono(new Float32Array([1]), 48000, -1)).toThrow();
  });
});

describe('encodeWavPcm16', () => {
  it('writes a canonical 44-byte PCM header', () => {
    const wav = encodeWavPcm16(new Float32Array([0, 0]), 16000);
    const view = new DataView(wav);

    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(ascii(view, 8, 4)).toBe('WAVE');
    expect(ascii(view, 12, 4)).toBe('fmt ');
    expect(ascii(view, 36, 4)).toBe('data');

    expect(view.getUint32(16, true)).toBe(16);     // PCM fmt chunk size
    expect(view.getUint16(20, true)).toBe(1);      // uncompressed PCM
    expect(view.getUint16(22, true)).toBe(1);      // mono
    expect(view.getUint32(24, true)).toBe(16000);  // sample rate
    expect(view.getUint16(34, true)).toBe(16);     // bits per sample
  });

  it('reports sizes consistent with the payload', () => {
    const wav = encodeWavPcm16(new Float32Array(100), 16000);
    const view = new DataView(wav);
    expect(wav.byteLength).toBe(44 + 200);
    expect(view.getUint32(4, true)).toBe(36 + 200); // RIFF size
    expect(view.getUint32(40, true)).toBe(200);     // data size
    expect(view.getUint32(28, true)).toBe(16000 * 2); // byte rate
    expect(view.getUint16(32, true)).toBe(2);       // block align
  });

  it('clamps samples outside [-1, 1] instead of wrapping', () => {
    // Without clamping, a hot capture wraps on the cast and loud speech
    // becomes noise — audible as a crackle, garbage to the model.
    const wav = encodeWavPcm16(new Float32Array([2, -2]), 16000);
    const view = new DataView(wav);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
  });

  it('round-trips full-scale and silent samples', () => {
    const wav = encodeWavPcm16(new Float32Array([1, 0, -1]), 16000);
    const view = new DataView(wav);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(0);
    expect(view.getInt16(48, true)).toBe(-32768);
  });

  it('writes little-endian samples', () => {
    // RIFF is little-endian throughout; a big-endian write is silent noise.
    const wav = encodeWavPcm16(new Float32Array([1]), 16000);
    const bytes = new Uint8Array(wav);
    expect(bytes[44]).toBe(0xff);
    expect(bytes[45]).toBe(0x7f);
  });

  it('encodes an empty capture as a header with no data', () => {
    const wav = encodeWavPcm16(new Float32Array(0), 16000);
    expect(wav.byteLength).toBe(44);
    expect(new DataView(wav).getUint32(40, true)).toBe(0);
  });
});

describe('audioBufferToWav', () => {
  it('mixes, resamples and encodes at the target rate', () => {
    const left = new Float32Array(48000).fill(0.5);
    const right = new Float32Array(48000).fill(-0.5);
    const wav = audioBufferToWav(fakeAudioBuffer([left, right], 48000), 16000);
    const view = new DataView(wav);

    expect(view.getUint32(24, true)).toBe(16000);
    // One second of 48kHz stereo becomes one second of 16kHz mono.
    expect(view.getUint32(40, true)).toBe(16000 * 2);
    // Equal and opposite channels cancel to silence.
    expect(view.getInt16(44, true)).toBe(0);
  });
});
