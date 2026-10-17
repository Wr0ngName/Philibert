/**
 * Image bytes, as they arrive over IPC, made drawable.
 *
 * A blob URL rather than a `data:` URI. A data URI of a multi-megabyte image
 * is a multi-megabyte string living in the DOM, re-parsed on every render; a
 * blob URL is a handle. Whoever creates one owns it and must revoke it when
 * the image goes away — the list is virtualised, so rows and their images are
 * mounted and unmounted constantly.
 */
export function blobUrlFromBase64(base64: string, mediaType: string): string {
  const binary = atob(base64);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) buffer[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([buffer], { type: mediaType }));
}
