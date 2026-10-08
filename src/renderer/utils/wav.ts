/**
 * Encoding captured audio as 16-bit PCM WAV, the format the whisper binary
 * reads.
 *
 * The microphone is not the right shape for transcription on either axis: it
 * is typically stereo at 44.1 or 48kHz, while whisper.cpp works at 16kHz mono
 * (`WHISPER_SAMPLE_RATE`). Its CLI decodes through miniaudio and would
 * resample for us, so converting here is not a correctness requirement — it
 * makes the buffer that crosses the IPC boundary about a sixth of the size,
 * and keeps a 44.1kHz capture from being resampled twice.
 *
 * MediaRecorder produces WebM/Opus, which miniaudio does not decode, so the
 * capture has to be turned into PCM on this side regardless.
 */

/** Bytes in the canonical WAV header this writes. */
const WAV_HEADER_BYTES = 44;

/** Bits per sample. 16-bit signed PCM is what `format = 1` means below. */
const BITS_PER_SAMPLE = 16;

/**
 * Mix an AudioBuffer's channels down to one.
 *
 * Averaging rather than taking the first channel: a capture where the voice
 * sits mostly in one channel would otherwise lose most of its level, and a
 * stereo mic with one dead channel would halve it.
 */
export function mixToMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);

  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }

  const mono = new Float32Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i];
    mono[i] = sum / channels.length;
  }
  return mono;
}

/**
 * Resample mono float samples by linear interpolation.
 *
 * Linear interpolation is cheap and lossy at the top of the band, which is
 * the right trade here: the target rate is 16kHz, speech lives well below the
 * 8kHz Nyquist limit that implies, and the consumer is a speech model rather
 * than a listener. Returns the input untouched when the rates already match.
 */
export function resampleMono(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  if (fromRate <= 0 || toRate <= 0) {
    throw new Error(`Invalid sample rates: ${fromRate} -> ${toRate}`);
  }

  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const weight = position - left;
    out[i] = samples[left] * (1 - weight) + samples[right] * weight;
  }
  return out;
}

/**
 * Wrap mono float samples in a 16-bit PCM WAV container.
 *
 * Samples outside [-1, 1] are clamped before conversion. Without that, a hot
 * capture wraps around on the cast and turns loud speech into noise, which is
 * audible as a crackle and reads to a speech model as garbage.
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  const channels = 1;
  const byteRate = sampleRate * channels * (BITS_PER_SAMPLE / 8);

  // RIFF container
  writeAscii(0, 'RIFF');
  view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true);
  writeAscii(8, 'WAVE');
  // fmt chunk
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);           // chunk size for PCM
  view.setUint16(20, 1, true);            // format 1 = uncompressed PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, channels * (BITS_PER_SAMPLE / 8), true); // block align
  view.setUint16(34, BITS_PER_SAMPLE, true);
  // data chunk
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    // Asymmetric scaling: int16 holds -32768..32767, so the negative side has
    // one more step than the positive one.
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}

/**
 * Turn a decoded capture into a 16kHz mono PCM WAV ready for transcription.
 */
export function audioBufferToWav(buffer: AudioBuffer, targetRate: number): ArrayBuffer {
  const mono = mixToMono(buffer);
  const resampled = resampleMono(mono, buffer.sampleRate, targetRate);
  return encodeWavPcm16(resampled, targetRate);
}
