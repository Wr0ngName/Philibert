/**
 * The page's Content-Security-Policy, against the images the app draws.
 *
 * Every component test runs on a bare page; here the policy from `index.html`
 * is enforced (see enforceAppContentSecurityPolicy) and Chromium is asked to
 * draw the kinds of URL the components produce.
 *
 * Run with `npm run test:browser`.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { blobUrlFromBase64 } from '../utils/image-bytes';

import { enforceAppContentSecurityPolicy } from './support/app-content-security-policy';

/** A real 1×1 PNG. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Resolve with whether the image decoded under the policy. */
function draws(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.addEventListener('load', () => resolve(img.naturalWidth > 0), { once: true });
    img.addEventListener('error', () => resolve(false), { once: true });
    img.src = src;
  });
}

describe("index.html's Content-Security-Policy", () => {
  beforeAll(enforceAppContentSecurityPolicy);

  it('lets a blob image draw, which is how stored and local images are shown', async () => {
    const url = blobUrlFromBase64(PNG_1X1, 'image/png');
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
