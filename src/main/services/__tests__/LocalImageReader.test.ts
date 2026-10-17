/**
 * Reading an image a message points at by path, against a real directory.
 *
 * The path comes out of a transcript — text the model wrote — so the hostile
 * cases matter as much as the happy one: this reads outside the working
 * directory on purpose, and the only thing keeping it to pictures is that it
 * answers with nothing but bytes that ARE a picture.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  MAX_LOCAL_IMAGE_BYTES,
  readLocalImage,
  resolveImageReference,
  sniffImageMediaType,
} from '../LocalImageReader';

/** A real 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
/** A real 2×2 GIF. */
const GIF = Buffer.from('R0lGODdhAgACAIAAAP///////ywAAAAAAgACAAACA0QCBQA7', 'base64');

let dir: string;

beforeAll(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-image-'));
  await fs.promises.mkdir(path.join(dir, 'shots dir'));
  await fs.promises.writeFile(path.join(dir, 'shots dir', 'a zoom.png'), PNG);
  await fs.promises.writeFile(path.join(dir, 'really-a-gif.png'), GIF);
  await fs.promises.writeFile(path.join(dir, 'secrets.png'), 'API_KEY=not-a-picture');
});

afterAll(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('resolveImageReference', () => {
  it('takes an absolute path as it is', () => {
    const file = path.join(dir, 'x.png');
    expect(resolveImageReference(file, null)).toBe(file);
  });

  it('resolves a relative path against the base directory', () => {
    expect(resolveImageReference('./shots/x.png', dir)).toBe(path.join(dir, 'shots', 'x.png'));
  });

  it('has nothing to resolve a relative path against without a base', () => {
    expect(resolveImageReference('shots/x.png', null)).toBeNull();
  });

  it('turns a file URL into its path', () => {
    const file = path.join(dir, 'shots dir', 'a zoom.png');
    expect(resolveImageReference(pathToFileURL(file).href, null)).toBe(file);
  });

  it('is not fooled into reading a web or data URL as a file', () => {
    expect(resolveImageReference('https://example.com/x.png', dir)).toBeNull();
    expect(resolveImageReference('data:image/png;base64,AAAA', dir)).toBeNull();
  });

  it('does not mistake a Windows drive for a URL scheme', () => {
    // On Windows that is an absolute path; elsewhere it is not absolute, and
    // is resolved like any other relative path. Either way it is a file.
    expect(resolveImageReference('C:/Users/me/x.png', dir)).not.toBeNull();
    expect(resolveImageReference('C:\\Users\\me\\x.png', dir)).not.toBeNull();
  });

  it('ignores blank references', () => {
    expect(resolveImageReference('   ', dir)).toBeNull();
  });
});

describe('sniffImageMediaType', () => {
  it('knows each format by its signature', () => {
    expect(sniffImageMediaType(PNG)).toBe('image/png');
    expect(sniffImageMediaType(GIF)).toBe('image/gif');
    expect(sniffImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMediaType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe('image/webp');
  });

  it('is null for anything else', () => {
    expect(sniffImageMediaType(Buffer.from('hello'))).toBeNull();
    expect(sniffImageMediaType(Buffer.alloc(0))).toBeNull();
    expect(sniffImageMediaType(Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'latin1'))).toBeNull();
  });
});

describe('readLocalImage', () => {
  it('reads an image by absolute path, spaces and all', async () => {
    const read = await readLocalImage(path.join(dir, 'shots dir', 'a zoom.png'), null);
    expect(read).toEqual({ base64: PNG.toString('base64'), mediaType: 'image/png' });
  });

  it('reads an image by a path relative to the base', async () => {
    const read = await readLocalImage('shots dir/a zoom.png', dir);
    expect(read?.mediaType).toBe('image/png');
  });

  it('reports what the bytes are, not what the name says', async () => {
    const read = await readLocalImage(path.join(dir, 'really-a-gif.png'), null);
    expect(read).toEqual({ base64: GIF.toString('base64'), mediaType: 'image/gif' });
  });

  it('answers nothing for a file that is not an image, whatever it is called', async () => {
    expect(await readLocalImage(path.join(dir, 'secrets.png'), null)).toBeNull();
  });

  it('answers nothing for a missing file', async () => {
    expect(await readLocalImage(path.join(dir, 'nope.png'), null)).toBeNull();
  });

  it('answers nothing for a directory', async () => {
    expect(await readLocalImage(path.join(dir, 'shots dir'), null)).toBeNull();
  });

  it('answers nothing for a file too large to draw', async () => {
    const big = path.join(dir, 'big.png');
    const handle = await fs.promises.open(big, 'w');
    try {
      await handle.write(PNG, 0, PNG.length, 0);
      await handle.truncate(MAX_LOCAL_IMAGE_BYTES + 1);
    } finally {
      await handle.close();
    }
    expect(await readLocalImage(big, null)).toBeNull();
  });
});
