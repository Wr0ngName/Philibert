/**
 * Image files on this machine that a message points at by path.
 *
 * Claude routinely writes `![shot](C:/work/shots/a.png)` or `![a](./out.png)`
 * after producing a picture. The renderer cannot draw that by itself: a path
 * is not a URL the page can load, and the page's policy would refuse a
 * `file:` URL even if it were one. So the renderer asks for the bytes here and
 * draws them as a blob, the same way it draws stored images.
 *
 * Unlike `files:read`, this is not confined to the working directory: the
 * pictures Claude makes are routinely written outside it, and a path the
 * transcript names is the whole point. What keeps it from being a way to read
 * any file is that it only ever answers with an IMAGE — the bytes must carry
 * the signature of one of the four formats the app handles, whatever the file
 * is called — and only up to a size worth drawing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ImageMediaType } from '../../shared/types';
import logger from '../utils/logger';

/**
 * The largest local image that will be drawn.
 *
 * Larger than the store's 5 MB: that cap is the API's per-image limit, and
 * nothing read here is sent anywhere — it is only shown. A full-resolution
 * screenshot runs past 5 MB easily. The bound is what keeps one message from
 * pushing an arbitrarily large file through IPC.
 */
export const MAX_LOCAL_IMAGE_BYTES = 32 * 1024 * 1024;

/** `C:/…` or `C:\…`: a Windows drive path, not a URL scheme. */
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;

/** Any `scheme:` prefix. */
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * The file a reference names, or null when it does not name one.
 *
 * Accepts an absolute path, a `file:` URL, and a path relative to `baseDir`.
 * A relative path with no base has nothing to be relative to, and any other
 * URL scheme is not a file at all.
 */
export function resolveImageReference(reference: string, baseDir: string | null): string | null {
  const trimmed = reference.trim();
  if (!trimmed) return null;

  if (trimmed.toLowerCase().startsWith('file:')) {
    try {
      return path.normalize(fileURLToPath(trimmed));
    } catch {
      return null;
    }
  }

  if (URL_SCHEME.test(trimmed) && !WINDOWS_DRIVE.test(trimmed)) return null;

  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  if (!baseDir) return null;
  return path.resolve(baseDir, trimmed);
}

/**
 * The image format the bytes are, by their signature — never by the file
 * name, which is exactly what cannot be trusted to keep this to images.
 */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | null {
  const starts = (...signature: number[]) => signature.every((byte, i) => bytes[i] === byte);

  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  // RIFF....WEBP
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45
    && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

/**
 * Read an image a message points at. Null when there is nothing to draw: no
 * such file, not an image, too large — a gap in the message, not an error.
 */
export async function readLocalImage(
  reference: string,
  baseDir: string | null,
): Promise<{ base64: string; mediaType: ImageMediaType } | null> {
  const filePath = resolveImageReference(reference, baseDir);
  if (!filePath) return null;

  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_LOCAL_IMAGE_BYTES) {
      logger.warn('A referenced image is too large to draw', {
        filePath, byteSize: stat.size, limit: MAX_LOCAL_IMAGE_BYTES,
      });
      return null;
    }

    const bytes = await fs.promises.readFile(filePath);
    const mediaType = sniffImageMediaType(bytes);
    if (!mediaType) {
      logger.warn('A referenced file is not an image we draw', { filePath });
      return null;
    }
    return { base64: bytes.toString('base64'), mediaType };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
      logger.warn('A referenced image cannot be read', { filePath, code });
      return null;
    }
    logger.error('Failed to read a referenced image', { filePath, error });
    throw error;
  }
}
