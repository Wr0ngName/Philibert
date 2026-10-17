/**
 * Draw the images rendered markdown points at by path.
 *
 * `renderMarkdown` hands a local reference over as `data-local-src` rather
 * than a `src`, because a path is not something the page can load. This reads
 * each one through the main process and gives it a blob URL — the same way
 * stored images are drawn — or, when there is no picture at that path, says
 * so in place of a broken image.
 *
 * The markdown is `v-html`, so every change to it replaces the elements this
 * decorated; that is why the pass runs after each render rather than once.
 * Bytes are kept per reference for the life of the component, so a message
 * re-rendering while it streams does not read its images again.
 */

import { onUnmounted, watch, type Ref } from 'vue';

import { blobUrlFromBase64 } from '../utils/image-bytes';
import { logger } from '../utils/logger';
import { LOCAL_IMAGE_ATTR } from '../utils/markdown';

/** Matches how MessageImages draws an image and a gap, so the two read alike. */
const DRAWN_CLASSES = ['max-w-full', 'max-h-96', 'rounded-lg', 'border', 'border-surface-200', 'dark:border-surface-700'];
const MISSING_CLASSES = 'inline-block px-3 py-2 rounded-lg border border-dashed border-surface-300 dark:border-surface-600 text-xs text-surface-500 dark:text-surface-400';

export function useLocalImages(
  root: Ref<HTMLElement | null>,
  html: () => string,
  baseDir: () => string | null,
): void {
  /** Blob URL per reference, owned here and revoked on unmount. */
  const urls = new Map<string, string>();
  /** References with no picture behind them. */
  const missing = new Set<string>();
  /** References being read, so one read serves every copy of the image. */
  const pending = new Set<string>();
  let disposed = false;

  /** Keyed with the base, since a relative path means a different file under another. */
  function keyFor(reference: string): string {
    return `${baseDir() ?? ''}\n${reference}`;
  }

  function showMissing(img: HTMLImageElement, reference: string): void {
    const gap = document.createElement('span');
    gap.className = MISSING_CLASSES;
    gap.textContent = `${img.alt || 'Image'} — not found at ${reference}`;
    img.replaceWith(gap);
  }

  function draw(): void {
    const el = root.value;
    if (!el || disposed) return;

    for (const img of el.querySelectorAll<HTMLImageElement>(`img[${LOCAL_IMAGE_ATTR}]`)) {
      const reference = img.getAttribute(LOCAL_IMAGE_ATTR) ?? '';
      const key = keyFor(reference);

      const url = urls.get(key);
      if (url) {
        if (img.getAttribute('src') !== url) {
          img.classList.add(...DRAWN_CLASSES);
          img.src = url;
        }
      } else if (missing.has(key)) {
        showMissing(img, reference);
      } else if (!pending.has(key)) {
        void read(reference, key);
      }
    }
  }

  async function read(reference: string, key: string): Promise<void> {
    pending.add(key);
    try {
      const bytes = await window.electron.files.readImage(reference, baseDir());
      if (!bytes) {
        missing.add(key);
      } else if (disposed) {
        return;
      } else {
        urls.set(key, blobUrlFromBase64(bytes.base64, bytes.mediaType));
      }
    } catch (err) {
      logger.error('Failed to read an image a message points at', { reference, err });
      missing.add(key);
    } finally {
      pending.delete(key);
    }
    // The elements may have been replaced while this was read; draw whatever
    // is there now.
    draw();
  }

  watch([root, html, baseDir], draw, { flush: 'post', immediate: true });

  onUnmounted(() => {
    disposed = true;
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
  });
}
