/** A path's last segment, for either separator: the folder's name for a project. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
