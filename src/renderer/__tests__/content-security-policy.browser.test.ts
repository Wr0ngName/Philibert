/**
 * The page's Content-Security-Policy, against the images the app draws.
 *
 * Every other image test runs without it: the browser suite mounts components
 * into a bare page, never `index.html`, so a policy that forbids a kind of URL
 * the app relies on passes every component test and shows the user a broken
 * image. Here the policy is lifted out of `index.html` itself and enforced on
 * the test page, and Chromium is asked to draw what the components draw.
 *
 * Run with `npm run test:browser`.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import indexHtml from '../../../index.html?raw';

/** A real 1×1 PNG. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function policyFromIndexHtml(): string {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
  const meta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
  const content = meta?.getAttribute('content');
  if (!content) throw new Error('index.html carries no Content-Security-Policy');
  return content;
}

/** Resolve with whether the image decoded under the policy. */
function draws(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.addEventListener('load', () => resolve(img.naturalWidth > 0), { once: true });
    img.addEventListener('error', () => resolve(false), { once: true });
    img.src = src;
  });
}

function pngBytes(): Uint8Array<ArrayBuffer> {
  const binary = atob(PNG_1X1);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) buffer[i] = binary.charCodeAt(i);
  return buffer;
}

describe("index.html's Content-Security-Policy", () => {
  beforeAll(() => {
    const meta = document.createElement('meta');
    meta.httpEquiv = 'Content-Security-Policy';
    meta.content = policyFromIndexHtml();
    document.head.appendChild(meta);
  });

  it('lets a blob image draw, which is how stored and local images are shown', async () => {
    const url = URL.createObjectURL(new Blob([pngBytes()], { type: 'image/png' }));
    try {
      expect(await draws(url)).toBe(true);
    } finally {
      URL.revokeObjectURL(url);
    }
  });

  it('lets a data image draw', async () => {
    expect(await draws(`data:image/png;base64,${PNG_1X1}`)).toBe(true);
  });

  it('still refuses an image from elsewhere', async () => {
    // The policy exists to keep a transcript from pulling content off the
    // network; widening it for blobs must not widen it for that.
    expect(await draws('https://example.com/x.png')).toBe(false);
  });
});
