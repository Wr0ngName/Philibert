/**
 * Drawing a message's images, in a real browser.
 *
 * The store-level tests prove the bytes round-trip. They cannot prove the
 * bytes are a picture: happy-dom has no image decoder, so an `<img>` there
 * accepts any string as a src and reports nothing about it. Here Chromium
 * decodes what we hand it, and `naturalWidth` is the proof — base64 that was
 * mangled on the way through, a blob built with the wrong media type, or a
 * src that never resolved all show up as a zero.
 *
 * `window.electron` is stood up because there is no IPC in a browser at all.
 * Electron is the thing that is missing, not anything of ours: the component,
 * the blob handling and the decoding are real.
 *
 * Run with `npm run test:browser`.
 */

import { mount } from '@vue/test-utils';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { ImageMediaType, MessageImage } from '@shared/types';

import MessageImages from '../MessageImages.vue';

/** A real 1×1 PNG. Small, and genuinely decodable — which is the point. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A real 2×2 GIF, to prove the media type travels rather than being assumed. */
const GIF_2X2 = 'R0lGODdhAgACAIAAAP///////ywAAAAAAgACAAACA0QCBQA7';

const CONV = 'conv-pictures';

type StoredImage = { base64: string; mediaType: string };

/** The image store, as the main process would answer for it. */
function installImageIpc(bytes: Record<string, StoredImage>): { reads: string[] } {
  const reads: string[] = [];
  (window as unknown as { electron: unknown }).electron = {
    conversation: {
      readImage: async (conversationId: string, id: string, mediaType: string) => {
        reads.push(`${conversationId}/${id}/${mediaType}`);
        const found = bytes[id];
        return found ? { base64: found.base64, mediaType: found.mediaType } : null;
      },
    },
  };
  return { reads };
}

function reference(
  id: string,
  mediaType: ImageMediaType = 'image/png',
  extra: Partial<MessageImage> = {},
): MessageImage {
  return { id, mediaType, byteSize: 70, origin: 'tool', ...extra };
}

/** Let the fetch, the blob and the decode all finish. */
async function settle(frames = 10): Promise<void> {
  for (let i = 0; i < frames; i += 1) {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }
}

/** Resolve once the image has decoded, or say it never did. */
async function decoded(img: HTMLImageElement): Promise<void> {
  if (img.complete && img.naturalWidth > 0) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => resolve();
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', () => reject(new Error('the image failed to load')), { once: true });
    setTimeout(() => reject(new Error('the image never loaded')), 4000);
  });
}

describe('a message with images, in a real browser', () => {
  beforeEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('draws bytes the main process stored, and they really are a picture', async () => {
    installImageIpc({ img_a: { base64: PNG_1X1, mediaType: 'image/png' } });

    const wrapper = mount(MessageImages, {
      props: { conversationId: CONV, images: [reference('img_a')] },
      attachTo: document.body,
    });
    await settle();

    const img = wrapper.find('img').element as HTMLImageElement;
    await decoded(img);

    // Chromium decoded it: the bytes survived base64 → Blob → object URL.
    expect(img.naturalWidth).toBe(1);
    expect(img.naturalHeight).toBe(1);
    // A blob handle, not a multi-megabyte string sitting in the DOM.
    expect(img.src.startsWith('blob:')).toBe(true);
    expect(img.src).not.toContain(PNG_1X1);

    wrapper.unmount();
  });

  it('honours the media type rather than assuming png', async () => {
    installImageIpc({ img_gif: { base64: GIF_2X2, mediaType: 'image/gif' } });

    const wrapper = mount(MessageImages, {
      props: { conversationId: CONV, images: [reference('img_gif', 'image/gif')] },
      attachTo: document.body,
    });
    await settle();

    const img = wrapper.find('img').element as HTMLImageElement;
    await decoded(img);

    // A GIF decoded as a GIF: 2×2, not the 1×1 of the PNG above.
    expect(img.naturalWidth).toBe(2);
    expect(img.naturalHeight).toBe(2);

    wrapper.unmount();
  });

  it('draws several images on one message', async () => {
    installImageIpc({
      img_a: { base64: PNG_1X1, mediaType: 'image/png' },
      img_b: { base64: GIF_2X2, mediaType: 'image/gif' },
    });

    const wrapper = mount(MessageImages, {
      props: {
        conversationId: CONV,
        images: [reference('img_a'), reference('img_b', 'image/gif')],
      },
      attachTo: document.body,
    });
    await settle();

    const imgs = wrapper.findAll('img');
    expect(imgs).toHaveLength(2);
    await decoded(imgs[0].element as HTMLImageElement);
    await decoded(imgs[1].element as HTMLImageElement);
    expect((imgs[0].element as HTMLImageElement).naturalWidth).toBe(1);
    expect((imgs[1].element as HTMLImageElement).naturalWidth).toBe(2);

    wrapper.unmount();
  });

  it('shows a gap when the bytes are gone, not a broken image', async () => {
    // The reference outlived the file — a half-restored backup, a cleaned
    // directory. A broken-image icon says nothing; this says what happened.
    installImageIpc({});

    const wrapper = mount(MessageImages, {
      props: { conversationId: CONV, images: [reference('img_missing', 'image/png', { label: 'shot.png' })] },
      attachTo: document.body,
    });
    await settle();

    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toContain('no longer stored');
    expect(wrapper.text()).toContain('shot.png');

    wrapper.unmount();
  });

  it('releases the blob when the row goes away', async () => {
    // This list is virtualised: rows mount and unmount constantly while
    // scrolling. A blob URL that is never revoked is the decoded image held
    // for the lifetime of the window, once per row that ever scrolled past.
    installImageIpc({ img_a: { base64: PNG_1X1, mediaType: 'image/png' } });
    const revoke = vi.spyOn(URL, 'revokeObjectURL');

    const wrapper = mount(MessageImages, {
      props: { conversationId: CONV, images: [reference('img_a')] },
      attachTo: document.body,
    });
    await settle();
    const src = (wrapper.find('img').element as HTMLImageElement).src;
    expect(src.startsWith('blob:')).toBe(true);

    wrapper.unmount();

    expect(revoke).toHaveBeenCalledWith(src);
    revoke.mockRestore();
  });

  it('fetches each image once, not on every render', async () => {
    const { reads } = installImageIpc({ img_a: { base64: PNG_1X1, mediaType: 'image/png' } });

    const wrapper = mount(MessageImages, {
      props: { conversationId: CONV, images: [reference('img_a')] },
      attachTo: document.body,
    });
    await settle();
    // Something unrelated changes and the component re-renders.
    await wrapper.setProps({ images: [reference('img_a')] });
    await settle();

    expect(reads).toEqual([`${CONV}/img_a/image/png`]);

    wrapper.unmount();
  });

  it('draws nothing at all when a message has no images', async () => {
    installImageIpc({});

    const wrapper = mount(MessageImages, {
      props: { conversationId: CONV, images: [] },
      attachTo: document.body,
    });
    await settle();

    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text().trim()).toBe('');

    wrapper.unmount();
  });
});
