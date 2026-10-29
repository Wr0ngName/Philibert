/**
 * The image store, against a real (in-memory) filesystem.
 *
 * Both sources of images are untrusted: a tool result relays bytes produced
 * by whatever the model ran, and the composer relays whatever the user
 * pasted. So the hostile cases are the point of this file, not an appendix to
 * it — an id or a conversation id that reaches `path.join` can name a file
 * outside the store, and a media type that reaches the API unchecked fails a
 * turn the user has already waited for.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const files = new Map<string, Buffer>();
const dirs = new Set<string>(['/conversations', '/conversations/images']);
/** Files written, so a store that writes the same bytes again is caught. */
let writes = 0;

vi.mock('node:fs', () => {
  const promises = {
    mkdir: async (dir: string) => {
      const parts = dir.split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i += 1) dirs.add('/' + parts.slice(0, i).join('/'));
    },
    writeFile: async (file: string, data: Buffer) => {
      if (!dirs.has(file.slice(0, file.lastIndexOf('/')))) {
        const err: NodeJS.ErrnoException = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      files.set(file, Buffer.from(data));
      writes += 1;
    },
    access: async (file: string) => {
      if (!files.has(file) && !dirs.has(file)) {
        const err: NodeJS.ErrnoException = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
    },
    readFile: async (file: string) => {
      const found = files.get(file);
      if (!found) {
        const err: NodeJS.ErrnoException = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return found;
    },
    rm: async (dir: string) => {
      for (const key of [...files.keys()]) if (key.startsWith(dir + '/')) files.delete(key);
      for (const key of [...dirs]) if (key === dir || key.startsWith(dir + '/')) dirs.delete(key);
    },
  };
  return { default: { promises }, promises };
});

vi.mock('../../utils/paths', async () => {
  const actual = await vi.importActual<typeof import('../../utils/paths')>('../../utils/paths');
  return { ...actual, getConversationsPath: () => '/conversations' };
});

vi.mock('../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ImageStore, MAX_IMAGE_BYTES } from '../ImageStore';

/** A real, if tiny, PNG — bytes rather than a string pretending to be some. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('the image store', () => {
  let store: ImageStore;

  beforeEach(() => {
    files.clear();
    dirs.clear();
    dirs.add('/conversations');
    store = new ImageStore();
  });

  it('stores bytes and hands back a reference, not the bytes', async () => {
    const ref = await store.save('conv-1', {
      base64: PNG.toString('base64'), mediaType: 'image/png', origin: 'user',
    });

    expect(ref).not.toBeNull();
    expect(ref!.mediaType).toBe('image/png');
    expect(ref!.byteSize).toBe(PNG.length);
    expect(ref!.origin).toBe('user');
    // The reference is small enough to live on a message and travel with
    // every save, which is the whole reason the bytes are not on it.
    expect(JSON.stringify(ref!).length).toBeLessThan(200);
    expect(JSON.stringify(ref!)).not.toContain(PNG.toString('base64'));
  });

  it('reads back exactly what was written', async () => {
    const ref = await store.save('conv-1', {
      base64: PNG.toString('base64'), mediaType: 'image/png', origin: 'tool', label: 'shot.png',
    });

    const read = await store.read('conv-1', ref!.id, ref!.mediaType);

    expect(read?.mediaType).toBe('image/png');
    expect(Buffer.from(read!.base64, 'base64').equals(PNG)).toBe(true);
    expect(ref!.label).toBe('shot.png');
  });

  it('keeps one conversation images out of another', async () => {
    const ref = await store.save('conv-1', {
      base64: PNG.toString('base64'), mediaType: 'image/png', origin: 'user',
    });

    expect(await store.read('conv-2', ref!.id, ref!.mediaType)).toBeNull();
    expect(await store.read('conv-1', ref!.id, ref!.mediaType)).not.toBeNull();
  });

  it('refuses a media type the API does not take', async () => {
    // Refused here rather than at the API, which would fail a turn the user
    // has already waited through.
    for (const mediaType of ['image/svg+xml', 'image/bmp', 'application/pdf', 'text/html', '']) {
      expect(await store.save('conv-1', {
        base64: PNG.toString('base64'), mediaType, origin: 'user',
      }), mediaType).toBeNull();
    }
    expect(files.size).toBe(0);
  });

  it('refuses an image over the size limit', async () => {
    const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1, 1).toString('base64');

    expect(await store.save('conv-1', {
      base64: huge, mediaType: 'image/png', origin: 'user',
    })).toBeNull();
    expect(files.size).toBe(0);
  });

  it('accepts an image exactly at the limit', async () => {
    // The boundary in the other direction, so the cap cannot drift into
    // refusing what it is meant to allow.
    const atLimit = Buffer.alloc(MAX_IMAGE_BYTES, 1).toString('base64');

    const ref = await store.save('conv-1', {
      base64: atLimit, mediaType: 'image/png', origin: 'user',
    });

    expect(ref?.byteSize).toBe(MAX_IMAGE_BYTES);
  });

  it('refuses an empty image', async () => {
    expect(await store.save('conv-1', {
      base64: '', mediaType: 'image/png', origin: 'user',
    })).toBeNull();
  });

  it('cannot be made to write outside its own directory', async () => {
    // A conversation id reaches path.join. Without sanitising, '../..' walks
    // out of the store and writes wherever the traversal lands.
    const ref = await store.save('../../etc/evil', {
      base64: PNG.toString('base64'), mediaType: 'image/png', origin: 'user',
    });

    expect(ref).not.toBeNull();
    for (const written of files.keys()) {
      expect(written.startsWith('/conversations/images/')).toBe(true);
      expect(written).not.toContain('..');
    }
  });

  it('cannot be made to read outside its own directory', async () => {
    files.set('/conversations/secret.json', Buffer.from('not an image'));

    await expect(store.read('conv-1', '../../secret', 'image/png')).rejects.toThrow(/Invalid image/);
  });

  it('forgets a conversation images when it is deleted', async () => {
    const a = await store.save('conv-1', {
      base64: PNG.toString('base64'), mediaType: 'image/png', origin: 'user',
    });
    const b = await store.save('conv-2', {
      base64: PNG.toString('base64'), mediaType: 'image/png', origin: 'user',
    });

    await store.deleteAll('conv-1');

    // Gone from disk, not merely unreferenced: these are the largest files
    // this app writes, and nothing would ever name them again.
    expect(await store.read('conv-1', a!.id, a!.mediaType)).toBeNull();
    expect(files.size).toBe(1);
    // And the other conversation is untouched.
    expect(await store.read('conv-2', b!.id, b!.mediaType)).not.toBeNull();
  });

  it('says there are no bytes rather than failing when a file is missing', async () => {
    const ref = await store.save('conv-1', {
      base64: PNG.toString('base64'), mediaType: 'image/png', origin: 'user',
    });
    files.clear();

    // A gap in the transcript, not a reason to fail the conversation.
    expect(await store.read('conv-1', ref!.id, ref!.mediaType)).toBeNull();
  });

  describe('saveOnce, for images read again and again', () => {
    // An agent's transcript is re-read every few seconds while it runs, and
    // each read finds the same images.
    const input = { base64: PNG.toString('base64'), mediaType: 'image/png', origin: 'tool' as const };

    it('gives the same bytes the same reference, and writes them once', async () => {
      writes = 0;
      const first = await store.saveOnce('conv-1', input);
      const again = await store.saveOnce('conv-1', input);

      expect(again).toEqual(first);
      expect(writes).toBe(1);
      expect((await store.read('conv-1', first!.id, first!.mediaType))?.base64).toBe(PNG.toString('base64'));
    });

    it('gives different bytes different references', async () => {
      const first = await store.saveOnce('conv-1', input);
      const other = await store.saveOnce('conv-1', { ...input, base64: Buffer.concat([PNG, Buffer.from([0])]).toString('base64') });

      expect(other!.id).not.toBe(first!.id);
    });

    it('writes the bytes again when their file has gone', async () => {
      const first = await store.saveOnce('conv-1', input);
      files.clear();

      await store.saveOnce('conv-1', input);

      expect(await store.read('conv-1', first!.id, first!.mediaType)).not.toBeNull();
    });

    it('refuses what save refuses', async () => {
      expect(await store.saveOnce('conv-1', { ...input, mediaType: 'image/svg+xml' })).toBeNull();
      expect(await store.saveOnce('conv-1', { ...input, base64: '' })).toBeNull();
    });
  });
});
