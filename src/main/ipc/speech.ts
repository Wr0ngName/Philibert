/**
 * IPC handlers for local speech-to-text.
 *
 * Transcription runs in the main process because that is where the bundled
 * whisper binary and the model cache live. The renderer only captures audio
 * and hands over a WAV buffer.
 */

import { BrowserWindow, ipcMain } from 'electron';

import { isWhisperModelId, WHISPER_AUTO_LANGUAGE } from '../../shared/speech';
import { IPC_CHANNELS } from '../../shared/types';
import { collectAboutInfo } from '../services/AboutService';
import SpeechService from '../services/SpeechService';
import { sendToRenderer, formatErrorMessage } from '../utils/ipc-helpers';
import logger from '../utils/logger';

export function setupSpeechIPC(
  getMainWindow: () => BrowserWindow | null,
): SpeechService {
  const speechService = new SpeechService((progress) => {
    sendToRenderer(getMainWindow, IPC_CHANNELS.SPEECH_MODEL_PROGRESS, progress);
  });

  ipcMain.handle(IPC_CHANNELS.SPEECH_GET_AVAILABILITY, async () => {
    try {
      return await speechService.getAvailability();
    } catch (error) {
      logger.error('Failed to read speech availability', { error });
      // Availability is a question the UI asks on mount; a failure here should
      // hide the button, not break the window.
      return { available: false, downloadedModels: [] };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.SPEECH_TRANSCRIBE,
    async (_event, wav: ArrayBuffer, model: string, language: string) => {
      try {
        if (!(wav instanceof ArrayBuffer) || wav.byteLength === 0) {
          throw new Error('No audio supplied');
        }
        if (!isWhisperModelId(model)) {
          throw new Error(`Unknown speech model: ${model}`);
        }

        const result = await speechService.transcribe(Buffer.from(wav), {
          model,
          language: language || WHISPER_AUTO_LANGUAGE,
        });
        logger.info('Transcribed audio', {
          model,
          language,
          bytes: wav.byteLength,
          durationMs: result.durationMs,
          chars: result.text.length,
        });
        return result;
      } catch (error) {
        logger.error('Transcription failed', { error, model, language });
        throw new Error(formatErrorMessage('Transcription failed', error), { cause: error });
      }
    },
  );

  return speechService;
}

/**
 * Versions and environment facts for the About dialog. Lives here rather than
 * in its own module because it is a single read-only handler.
 */
export function setupAboutIPC(): void {
  ipcMain.handle(IPC_CHANNELS.ABOUT_GET_INFO, async () => {
    try {
      return await collectAboutInfo();
    } catch (error) {
      logger.error('Failed to collect About info', { error });
      throw new Error(formatErrorMessage('Failed to read version information', error), { cause: error });
    }
  });
}
