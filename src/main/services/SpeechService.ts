/**
 * Local speech-to-text, via the bundled whisper.cpp CLI.
 *
 * Runs the binary as a subprocess rather than linking a native addon. That is
 * the same shape as the bundled Claude CLI this app already spawns, and it
 * keeps the transcriber off Electron's ABI: a native addon would have to be
 * rebuilt for every Electron upgrade, whereas a subprocess does not care.
 *
 * The weights are not shipped. They are downloaded on first use and cached
 * under the app's user-data directory — the smallest useful model is 75MB and
 * the installers already carry a ~265MB CLI.
 */

import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { app } from 'electron';

import {
  GGML_MAGIC,
  isWhisperModelId,
  type ModelDownloadProgress,
  type TranscriptionResult,
  WHISPER_AUTO_LANGUAGE,
  type WhisperModelId,
  whisperModelFileName,
  whisperModelUrl,
} from '../../shared/speech';
import logger from '../utils/logger';
import { WhisperPaths } from '../utils/resourcePaths';

/** How long a single transcription may run before it is killed. */
const TRANSCRIBE_TIMEOUT_MS = 5 * 60 * 1000;

/** Threads given to the binary. Bounded so dictation cannot starve the app. */
const TRANSCRIBE_THREADS = 4;

export interface SpeechAvailability {
  /** Whether this build has the whisper binary at all. */
  available: boolean;
  /** Which models are already downloaded, so the UI can avoid a surprise wait. */
  downloadedModels: WhisperModelId[];
}

export interface TranscribeOptions {
  model: WhisperModelId;
  /** BCP-47-ish language code the binary understands, or 'auto'. */
  language: string;
}

export class SpeechService {
  /** In-flight model downloads, so two record presses cannot both fetch. */
  private downloads = new Map<WhisperModelId, Promise<string>>();

  constructor(
    private readonly onDownloadProgress?: (progress: ModelDownloadProgress) => void,
  ) {}

  /** Directory holding cached weights. */
  private modelsDir(): string {
    return path.join(app.getPath('userData'), 'whisper-models');
  }

  private modelPath(id: WhisperModelId): string {
    return path.join(this.modelsDir(), whisperModelFileName(id));
  }

  /** Whether a model's weights are already cached and look like weights. */
  private async isModelUsable(id: WhisperModelId): Promise<boolean> {
    const file = this.modelPath(id);
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile() || stat.size === 0) return false;
      return await this.hasGgmlMagic(file);
    } catch {
      return false;
    }
  }

  /**
   * Whether a file starts with the GGML magic bytes.
   *
   * Guards against a cached HTML error page rather than a truncated download:
   * a Hugging Face error or a captive portal answers with 200, and the bytes
   * would otherwise be kept as a model and fail inside the binary forever.
   */
  private async hasGgmlMagic(file: string): Promise<boolean> {
    let handle: fsp.FileHandle | undefined;
    try {
      handle = await fsp.open(file, 'r');
      const buffer = Buffer.alloc(GGML_MAGIC.length);
      const { bytesRead } = await handle.read(buffer, 0, GGML_MAGIC.length, 0);
      return bytesRead === GGML_MAGIC.length && buffer.toString('ascii') === GGML_MAGIC;
    } catch {
      return false;
    } finally {
      await handle?.close();
    }
  }

  /** What the renderer needs to decide whether to offer the mic. */
  async getAvailability(): Promise<SpeechAvailability> {
    const binary = WhisperPaths.findBundledBinary();
    if (!binary) return { available: false, downloadedModels: [] };

    const downloadedModels: WhisperModelId[] = [];
    let entries: string[];
    try {
      entries = await fsp.readdir(this.modelsDir());
    } catch {
      // No cache directory yet is the normal first-run state.
      return { available: true, downloadedModels };
    }

    for (const entry of entries) {
      const match = /^ggml-(.+)\.bin$/.exec(entry);
      if (!match || !isWhisperModelId(match[1])) continue;
      if (await this.isModelUsable(match[1])) downloadedModels.push(match[1]);
    }
    return { available: true, downloadedModels };
  }

  /**
   * Ensure a model is cached, downloading it if not, and return its path.
   *
   * Concurrent callers share one download. The file is written to a temporary
   * name and renamed only once its magic bytes check out, so an interrupted
   * download can never leave a half-file that later looks cached.
   */
  async ensureModel(id: WhisperModelId): Promise<string> {
    if (await this.isModelUsable(id)) return this.modelPath(id);

    const existing = this.downloads.get(id);
    if (existing) return existing;

    const download = this.downloadModel(id).finally(() => this.downloads.delete(id));
    this.downloads.set(id, download);
    return download;
  }

  private async downloadModel(id: WhisperModelId): Promise<string> {
    const target = this.modelPath(id);
    await fsp.mkdir(this.modelsDir(), { recursive: true });
    const temp = `${target}.${process.pid}.partial`;

    logger.info('Downloading whisper model', { model: id, url: whisperModelUrl(id) });

    const response = await fetch(whisperModelUrl(id));
    if (!response.ok || !response.body) {
      throw new Error(`Model download failed for ${id}: HTTP ${response.status}`);
    }

    const totalHeader = response.headers.get('content-length');
    const totalBytes = totalHeader ? Number(totalHeader) : null;
    let receivedBytes = 0;

    try {
      const handle = await fsp.open(temp, 'w');
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          await handle.write(chunk);
          receivedBytes += chunk.byteLength;
          this.onDownloadProgress?.({ model: id, receivedBytes, totalBytes });
        }
      } finally {
        await handle.close();
      }

      if (!(await this.hasGgmlMagic(temp))) {
        throw new Error(
          `Downloaded file for ${id} is not a GGML model — the server likely returned an error page`,
        );
      }

      await fsp.rename(temp, target);
      logger.info('Whisper model ready', { model: id, bytes: receivedBytes });
      return target;
    } catch (error) {
      await fsp.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Transcribe 16-bit PCM WAV audio.
   *
   * The binary reads a file rather than stdin, so the audio is written to a
   * temporary file and removed afterwards whatever the outcome.
   */
  async transcribe(wav: Buffer, options: TranscribeOptions): Promise<TranscriptionResult> {
    const binary = WhisperPaths.findBundledBinary();
    if (!binary) {
      throw new Error('Speech-to-text is not available in this build (no whisper binary bundled)');
    }

    const model = await this.ensureModel(options.model);
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'philibert-stt-'));
    const audioPath = path.join(dir, 'input.wav');
    await fsp.writeFile(audioPath, wav);

    const started = Date.now();
    try {
      const text = await this.runBinary(binary, [
        '-m', model,
        '-f', audioPath,
        // Language: 'auto' is what the binary itself calls detection.
        '-l', options.language || WHISPER_AUTO_LANGUAGE,
        // -nt drops timestamps and -np drops the banner and progress lines, so
        // stdout is the transcript and nothing else. The vendor CI job
        // smoke-tests exactly this contract.
        '-nt',
        '-np',
        '-t', String(TRANSCRIBE_THREADS),
      ]);
      return { text: text.trim(), durationMs: Date.now() - started };
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Run the binary and resolve with its stdout, or reject with its stderr. */
  private runBinary(binary: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`Transcription timed out after ${TRANSCRIBE_TIMEOUT_MS}ms`));
      }, TRANSCRIBE_TIMEOUT_MS);

      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout);
          return;
        }
        // stderr carries the binary's own diagnostics; surface them rather
        // than a bare exit code, which says nothing actionable.
        reject(new Error(`whisper-cli exited with code ${code}: ${stderr.trim() || '(no output)'}`));
      });
    });
  }
}

/** Whether this build can transcribe at all, without constructing a service. */
export function isSpeechAvailable(): boolean {
  return WhisperPaths.findBundledBinary() !== null;
}

export default SpeechService;
