/**
 * Which files "Show changes" is offered for.
 *
 * Text shows as a patch, pictures as before and after, other binary files as
 * the bytes that differ. Video, audio and archives are left out: their
 * content is compressed, so a change of any size rewrites everything after
 * it, and neither a patch nor a byte comparison says anything about it.
 */

const WITHOUT_CHANGES_VIEW = new Set([
  // Video
  'mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ogv',
  // Audio
  'mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'wma', 'aiff', 'mid', 'midi',
  // Archives and compressed files
  'zip', 'gz', 'tgz', 'tar', '7z', 'rar', 'xz', 'bz2', 'zst', 'lz4', 'jar', 'war', 'apk', 'dmg', 'iso',
]);

/** Whether "Show changes" can show something for a file, by its name. */
export function canShowChanges(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return true;
  return !WITHOUT_CHANGES_VIEW.has(fileName.slice(dot + 1).toLowerCase());
}
