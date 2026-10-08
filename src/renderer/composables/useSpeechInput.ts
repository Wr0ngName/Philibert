/**
 * Microphone dictation.
 *
 * Records from the microphone, converts the capture to the 16kHz mono PCM WAV
 * the whisper binary reads, and hands it to the main process to transcribe.
 *
 * MediaRecorder gives WebM/Opus, which the binary cannot decode, so the audio
 * is decoded with the Web Audio API and re-encoded here. Decoding through
 * `decodeAudioData` rather than tapping raw PCM during capture avoids both the
 * deprecated ScriptProcessorNode and the separate module file an AudioWorklet
 * would need.
 */

import { ref, computed, onUnmounted } from 'vue';

import { WHISPER_SAMPLE_RATE, type ModelDownloadProgress } from '@shared/speech';
import type { WhisperModelId } from '@shared/types';

import { logger } from '../utils/logger';
import { audioBufferToWav } from '../utils/wav';

export type SpeechPhase = 'idle' | 'recording' | 'transcribing';

export function useSpeechInput() {
  const phase = ref<SpeechPhase>('idle');
  const error = ref<string | null>(null);
  const downloadProgress = ref<ModelDownloadProgress | null>(null);

  const isRecording = computed(() => phase.value === 'recording');
  const isBusy = computed(() => phase.value !== 'idle');

  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];

  const cleanupProgress = window.electron.speech.onModelProgress((progress) => {
    downloadProgress.value = progress;
  });

  /** Stop the microphone. Leaving the track live keeps the OS mic indicator on. */
  function releaseStream(): void {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  function reset(): void {
    recorder = null;
    chunks = [];
    releaseStream();
  }

  /**
   * Begin recording. Resolves once the microphone is live, so a caller can
   * reflect the recording state without racing the permission prompt.
   */
  async function start(): Promise<void> {
    if (phase.value !== 'idle') return;
    error.value = null;
    downloadProgress.value = null;

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (cause) {
      // A denied or absent microphone is a normal outcome, not a crash.
      error.value = 'Microphone unavailable or permission denied';
      logger.warn('Microphone unavailable', { error: cause });
      reset();
      return;
    }

    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.start();
    phase.value = 'recording';
  }

  /**
   * Stop recording and transcribe what was captured.
   *
   * Returns the transcript, or null when there was nothing to transcribe or it
   * failed — the caller inserts text on a string and shows `error` otherwise.
   */
  async function stopAndTranscribe(
    model: WhisperModelId,
    language: string,
  ): Promise<string | null> {
    if (phase.value !== 'recording' || !recorder) return null;

    const captured = await new Promise<Blob>((resolve) => {
      const active = recorder!;
      active.addEventListener('stop', () => {
        resolve(new Blob(chunks, { type: active.mimeType || 'audio/webm' }));
      }, { once: true });
      active.stop();
    });

    releaseStream();
    phase.value = 'transcribing';

    try {
      if (captured.size === 0) {
        error.value = 'Nothing was recorded';
        return null;
      }

      const wav = await encodeForWhisper(captured);
      const { text } = await window.electron.speech.transcribe(wav, model, language);
      if (!text) {
        // Silence transcribes to nothing; say so rather than appearing to hang.
        error.value = 'No speech detected';
        return null;
      }
      return text;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Transcription failed';
      logger.error('Transcription failed', { error: cause });
      return null;
    } finally {
      phase.value = 'idle';
      downloadProgress.value = null;
      reset();
    }
  }

  /** Discard a recording in progress without transcribing it. */
  function cancel(): void {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    reset();
    phase.value = 'idle';
    downloadProgress.value = null;
  }

  onUnmounted(() => {
    cancel();
    cleanupProgress();
  });

  return {
    phase,
    error,
    downloadProgress,
    isRecording,
    isBusy,
    start,
    stopAndTranscribe,
    cancel,
  };
}

/**
 * Decode a captured blob and re-encode it as 16kHz mono PCM WAV.
 *
 * The AudioContext is created at the target rate so the browser's own
 * resampler does the work where it can, and closed afterwards — contexts are a
 * limited resource and leaking one per dictation eventually fails to allocate.
 */
async function encodeForWhisper(captured: Blob): Promise<ArrayBuffer> {
  const encoded = await captured.arrayBuffer();
  const context = new AudioContext({ sampleRate: WHISPER_SAMPLE_RATE });
  try {
    const decoded = await context.decodeAudioData(encoded);
    return audioBufferToWav(decoded, WHISPER_SAMPLE_RATE);
  } finally {
    await context.close();
  }
}
