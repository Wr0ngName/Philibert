/**
 * Images a message points at by path, drawn in a real browser.
 *
 * Claude writes `![shot](C:/work/shots/a.png)` after making a picture, and
 * that was always drawn as a broken image: a path is not a URL the page can
 * load. Here Chromium decodes what the message ends up with, under the page's
 * own Content-Security-Policy, and `naturalWidth` is the proof.
 *
 * `window.electron` is stood up because there is no IPC in a browser at all;
 * it answers the way LocalImageReader does. The component, the markdown, the
 * blob handling and the decoding are real.
 *
 * Run with `npm run test:browser`.
 */

import { mount } from '@vue/test-utils';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

import type { ChatMessage } from '@shared/types';

import { enforceAppContentSecurityPolicy } from '../../../__tests__/support/app-content-security-policy';
import MessageItem from '../MessageItem.vue';

/** A real 1×1 PNG. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const SHOT = 'C:/Users/me/shots/rb27_cmp/grass_o6_2773_zoom.png';

/** The files on "disk", and every read asked for. */
function installFiles(files: Record<string, string>): { reads: Array<[string, string | null]> } {
  const reads: Array<[string, string | null]> = [];
  (window as unknown as { electron: unknown }).electron = {
    files: {
      readImage: async (reference: string, baseDir: string | null) => {
        reads.push([reference, baseDir]);
        const key = baseDir && !files[reference] ? `${baseDir}/${reference}` : reference;
        const base64 = files[key];
        return base64 ? { base64, mediaType: 'image/png' } : null;
      },
    },
  };
  return { reads };
}

function message(content: string): ChatMessage {
  return { id: 'm1', role: 'assistant', content, timestamp: 0 };
}

async function settle(frames = 10): Promise<void> {
  for (let i = 0; i < frames; i += 1) {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }
}

async function decoded(img: HTMLImageElement): Promise<void> {
  if (img.complete && img.naturalWidth > 0) return;
  await new Promise<void>((resolve, reject) => {
    img.addEventListener('load', () => resolve(), { once: true });
    img.addEventListener('error', () => reject(new Error('the image failed to load')), { once: true });
    setTimeout(() => reject(new Error('the image never loaded')), 4000);
  });
}

describe('an image a message points at by path, in a real browser', () => {
  // The page's real policy: the one that refused these images before.
  beforeAll(enforceAppContentSecurityPolicy);

  beforeEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('draws a picture named by an absolute Windows path', async () => {
    installFiles({ [SHOT]: PNG_1X1 });
    const wrapper = mount(MessageItem, {
      props: { message: message(`**Tile o6 2773 on grass**:\n\n![o6 2773](${SHOT})`) },
      attachTo: document.body,
    });
    await settle();

    const img = wrapper.find('img').element as HTMLImageElement;
    await decoded(img);
    expect(img.naturalWidth).toBe(1);
    expect(img.alt).toBe('o6 2773');
    wrapper.unmount();
  });

  it('resolves a relative path against the working directory', async () => {
    const { reads } = installFiles({ '/work/out/a.png': PNG_1X1 });
    const wrapper = mount(MessageItem, {
      props: { message: message('![a](out/a.png)'), workingDirectory: '/work' },
      attachTo: document.body,
    });
    await settle();

    await decoded(wrapper.find('img').element as HTMLImageElement);
    expect(reads).toEqual([['out/a.png', '/work']]);
    wrapper.unmount();
  });

  it('says the picture is not there instead of drawing it broken', async () => {
    installFiles({});
    const wrapper = mount(MessageItem, {
      props: { message: message(`![o6 2773](${SHOT})`) },
      attachTo: document.body,
    });
    await settle();

    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toContain(`o6 2773 — not found at ${SHOT}`);
    wrapper.unmount();
  });

  it('reads each picture once while the message keeps streaming', async () => {
    const { reads } = installFiles({ [SHOT]: PNG_1X1 });
    const wrapper = mount(MessageItem, {
      props: { message: message(`![a](${SHOT})`) },
      attachTo: document.body,
    });
    await settle();

    // Each chunk replaces the v-html, and with it the drawn image.
    for (const more of [' and', ' then', ' more']) {
      const content = `${(wrapper.props('message') as ChatMessage).content}${more}`;
      await wrapper.setProps({ message: message(content) });
      await settle(3);
    }

    const img = wrapper.find('img').element as HTMLImageElement;
    await decoded(img);
    expect(img.naturalWidth).toBe(1);
    expect(reads).toHaveLength(1);
    wrapper.unmount();
  });

  it('draws the same picture twice in one message from one read', async () => {
    const { reads } = installFiles({ [SHOT]: PNG_1X1 });
    const wrapper = mount(MessageItem, {
      props: { message: message(`![a](${SHOT})\n\n![b](${SHOT})`) },
      attachTo: document.body,
    });
    await settle();

    const images = wrapper.findAll('img').map((w) => w.element as HTMLImageElement);
    expect(images).toHaveLength(2);
    for (const img of images) await decoded(img);
    expect(reads).toHaveLength(1);
    wrapper.unmount();
  });

  it('releases the blob when the message goes away', async () => {
    installFiles({ [SHOT]: PNG_1X1 });
    const wrapper = mount(MessageItem, {
      props: { message: message(`![a](${SHOT})`) },
      attachTo: document.body,
    });
    await settle();
    const img = wrapper.find('img').element as HTMLImageElement;
    await decoded(img);
    const url = img.src;

    wrapper.unmount();

    // A revoked blob URL no longer resolves to anything.
    const again = new Image();
    const loaded = await new Promise<boolean>((resolve) => {
      again.onload = () => resolve(true);
      again.onerror = () => resolve(false);
      again.src = url;
    });
    expect(loaded).toBe(false);
  });
});
