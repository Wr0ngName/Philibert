/**
 * Speech-to-text model catalogue and audio format constants.
 *
 * Transcription runs locally through a bundled `whisper-cli` binary, which
 * needs a GGML weights file. Those files are far too large to ship inside the
 * installers — the smallest useful one is 75MB and the installers already
 * carry a ~265MB CLI — so they are fetched on first use and cached in the
 * app's user-data directory, the same trade the online Windows installer makes
 * for Node and Git.
 *
 * Why local at all: the Claude API has no audio input modality, so a recording
 * cannot simply be handed to the model — it has to become text on this machine
 * first. Doing that locally keeps the recording on the device, which matches
 * what channel mode exists for.
 */

import type { WhisperModelId } from './types';

/** A GGML model that can be downloaded and used for transcription. */
export interface WhisperModel {
  /** Model identifier, matching the `ggml-<id>.bin` name upstream publishes. */
  id: WhisperModelId;
  /** Label for the settings UI. */
  label: string;
  /** Approximate download size, for telling the user what they are in for. */
  approxBytes: number;
  /** Whether the model only handles English. */
  englishOnly: boolean;
  /** One-line description of the accuracy/speed trade. */
  description: string;
}

export type { WhisperModelId };

const MB = 1024 * 1024;

/**
 * The models offered, smallest first.
 *
 * Deliberately stops at `small`: `medium` is 1.5GB and `large-v3` 3GB, which
 * is not a reasonable first-use download for a dictation box. Sizes are the
 * published figures for the quantised-free `ggml-<id>.bin` files.
 */
export const WHISPER_MODELS: readonly WhisperModel[] = [
  {
    id: 'tiny.en',
    label: 'Tiny (English)',
    approxBytes: 75 * MB,
    englishOnly: true,
    description: 'Fastest, least accurate — fine for short dictation',
  },
  {
    id: 'tiny',
    label: 'Tiny (multilingual)',
    approxBytes: 75 * MB,
    englishOnly: false,
    description: 'Fastest, least accurate',
  },
  {
    id: 'base.en',
    label: 'Base (English)',
    approxBytes: 142 * MB,
    englishOnly: true,
    description: 'Good balance of speed and accuracy',
  },
  {
    id: 'base',
    label: 'Base (multilingual)',
    approxBytes: 142 * MB,
    englishOnly: false,
    description: 'Good balance of speed and accuracy',
  },
  {
    id: 'small.en',
    label: 'Small (English)',
    approxBytes: 466 * MB,
    englishOnly: true,
    description: 'More accurate, noticeably slower',
  },
  {
    id: 'small',
    label: 'Small (multilingual)',
    approxBytes: 466 * MB,
    englishOnly: false,
    description: 'More accurate, noticeably slower',
  },
];

/** The model used unless the user picks another. */
export const DEFAULT_WHISPER_MODEL: WhisperModelId = 'base.en';

/** Whether a value names a model in the catalogue. */
export function isWhisperModelId(value: unknown): value is WhisperModelId {
  return typeof value === 'string' && WHISPER_MODELS.some((m) => m.id === value);
}

/** Catalogue entry for an id, or undefined when it names no known model. */
export function whisperModel(id: WhisperModelId): WhisperModel | undefined {
  return WHISPER_MODELS.find((m) => m.id === id);
}

/** The file name a model's weights are stored under, upstream and locally. */
export function whisperModelFileName(id: WhisperModelId): string {
  return `ggml-${id}.bin`;
}

/**
 * Where a model's weights are published.
 *
 * Hugging Face hosts the GGML conversions that whisper.cpp's own
 * `download-ggml-model.sh` pulls from, under the same file names.
 */
export function whisperModelUrl(id: WhisperModelId): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${whisperModelFileName(id)}`;
}

/**
 * Magic bytes at the start of a GGML weights file.
 *
 * Checked after download because the failure this guards against is not a
 * truncated file but an HTML one: a Hugging Face error page or captive-portal
 * redirect arrives with a 200 and would otherwise be cached as a model and
 * fail cryptically inside the binary on every later run.
 */
export const GGML_MAGIC = 'ggml';

/**
 * Sample rate the audio is resampled to before transcription.
 *
 * whisper.cpp works at 16kHz (`WHISPER_SAMPLE_RATE`). Its CLI decodes through
 * miniaudio and would resample for us, so this is not a correctness
 * requirement — but a microphone typically captures at 48kHz, and converting
 * before the IPC hop makes the payload a third of the size.
 */
export const WHISPER_SAMPLE_RATE = 16000;

/** Language value meaning "let whisper detect it". */
export const WHISPER_AUTO_LANGUAGE = 'auto';

/** Outcome of a transcription attempt. */
export interface TranscriptionResult {
  /** The transcribed text, trimmed. Empty when the audio held no speech. */
  text: string;
  /** How long the binary took, for surfacing slow models to the user. */
  durationMs: number;
}

/** Progress of a model download, as reported to the renderer. */
export interface ModelDownloadProgress {
  model: WhisperModelId;
  receivedBytes: number;
  /** Total size when the server reported one, else null. */
  totalBytes: number | null;
}
