export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
  prereleaseNum: number | null;
}

export function parseVersion(version: string): ParsedVersion {
  const v = version.startsWith('v') ? version.slice(1) : version;
  const match = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z]+)\.(\d+))?$/);
  if (!match) {
    throw new Error(`Invalid version string: "${version}"`);
  }

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] ?? null,
    prereleaseNum: match[5] != null ? parseInt(match[5], 10) : null,
  };
}

/**
 * Compare two semver versions with prerelease support.
 * Returns -1 if v1 < v2, 0 if equal, 1 if v1 > v2.
 *
 * Prerelease versions are lower than their release counterpart:
 *   1.0.0-rc.1 < 1.0.0-rc.2 < 1.0.0
 */
export function compareVersions(v1: string, v2: string): -1 | 0 | 1 {
  const a = parseVersion(v1);
  const b = parseVersion(v2);

  for (const field of ['major', 'minor', 'patch'] as const) {
    if (a[field] < b[field]) return -1;
    if (a[field] > b[field]) return 1;
  }

  // Same major.minor.patch — compare prerelease
  if (a.prerelease === null && b.prerelease === null) return 0;
  // Release > prerelease
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  // Both have prerelease — compare tag alphabetically then number
  if (a.prerelease < b.prerelease) return -1;
  if (a.prerelease > b.prerelease) return 1;
  // Same prerelease tag — compare number
  const aNum = a.prereleaseNum ?? 0;
  const bNum = b.prereleaseNum ?? 0;
  if (aNum < bNum) return -1;
  if (aNum > bNum) return 1;
  return 0;
}

export function isPrerelease(version: string): boolean {
  return parseVersion(version).prerelease !== null;
}
