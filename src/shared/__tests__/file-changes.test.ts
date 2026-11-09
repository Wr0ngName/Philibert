/**
 * Which files "Show changes" is offered for. Asked for: not for files whose
 * changes nothing shows — video, audio, archives.
 */

import { describe, it, expect } from 'vitest';

import { canShowChanges } from '../file-changes';

describe('canShowChanges', () => {
  it('is offered for text, pictures and other binary files', () => {
    for (const name of ['notes.md', 'app.ts', 'Makefile', '.env', 'photo.PNG', 'icon.svg', 'data.bin', 'app.sqlite', 'doc.pdf']) {
      expect(canShowChanges(name), name).toBe(true);
    }
  });

  it('is not offered for video, audio or archives', () => {
    for (const name of ['clip.mp4', 'movie.MKV', 'song.mp3', 'take.wav', 'backup.zip', 'logs.tar.gz', 'image.iso']) {
      expect(canShowChanges(name), name).toBe(false);
    }
  });
});
