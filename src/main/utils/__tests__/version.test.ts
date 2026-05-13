import { describe, it, expect } from 'vitest';

import { parseVersion, compareVersions, isPrerelease } from '../version';

describe('parseVersion', () => {
  it('parses a stable version', () => {
    expect(parseVersion('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
      prereleaseNum: null,
    });
  });

  it('parses a version with v prefix', () => {
    expect(parseVersion('v1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
      prereleaseNum: null,
    });
  });

  it('parses an RC prerelease version', () => {
    expect(parseVersion('0.13.0-rc.1')).toEqual({
      major: 0,
      minor: 13,
      patch: 0,
      prerelease: 'rc',
      prereleaseNum: 1,
    });
  });

  it('parses a version with v prefix and prerelease', () => {
    expect(parseVersion('v2.0.0-rc.5')).toEqual({
      major: 2,
      minor: 0,
      patch: 0,
      prerelease: 'rc',
      prereleaseNum: 5,
    });
  });

  it('parses alpha/beta prerelease tags', () => {
    expect(parseVersion('1.0.0-alpha.3')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: 'alpha',
      prereleaseNum: 3,
    });
    expect(parseVersion('1.0.0-beta.1')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: 'beta',
      prereleaseNum: 1,
    });
  });

  it('throws on invalid version strings', () => {
    expect(() => parseVersion('')).toThrow('Invalid version string');
    expect(() => parseVersion('abc')).toThrow('Invalid version string');
    expect(() => parseVersion('1.2')).toThrow('Invalid version string');
    expect(() => parseVersion('1.2.3.4')).toThrow('Invalid version string');
    expect(() => parseVersion('1.2.3-rc')).toThrow('Invalid version string');
  });
});

describe('compareVersions', () => {
  it('returns 0 for equal stable versions', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('compares major versions', () => {
    expect(compareVersions('2.0.0', '1.0.0')).toBe(1);
    expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
  });

  it('compares minor versions', () => {
    expect(compareVersions('1.2.0', '1.1.0')).toBe(1);
    expect(compareVersions('1.1.0', '1.2.0')).toBe(-1);
  });

  it('compares patch versions', () => {
    expect(compareVersions('1.0.2', '1.0.1')).toBe(1);
    expect(compareVersions('1.0.1', '1.0.2')).toBe(-1);
  });

  it('stable > prerelease for same base version', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
  });

  it('compares prerelease numbers', () => {
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.1')).toBe(1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.2')).toBe(-1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0);
  });

  it('handles v prefix transparently', () => {
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('v1.0.0-rc.1', '1.0.0-rc.1')).toBe(0);
  });

  it('next version rc > current stable', () => {
    expect(compareVersions('1.1.0-rc.1', '1.0.0')).toBe(1);
    expect(compareVersions('0.14.0-rc.1', '0.13.0')).toBe(1);
  });

  it('compares prerelease tags alphabetically', () => {
    // alpha < beta < rc
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-beta.1')).toBe(-1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0-rc.1')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-rc.1')).toBe(-1);
  });

  it('returns 0 for equal prerelease versions', () => {
    expect(compareVersions('1.0.0-rc.3', '1.0.0-rc.3')).toBe(0);
  });
});

describe('isPrerelease', () => {
  it('returns false for stable versions', () => {
    expect(isPrerelease('1.0.0')).toBe(false);
    expect(isPrerelease('v0.13.0')).toBe(false);
  });

  it('returns true for prerelease versions', () => {
    expect(isPrerelease('1.0.0-rc.1')).toBe(true);
    expect(isPrerelease('v0.14.0-rc.3')).toBe(true);
    expect(isPrerelease('1.0.0-alpha.1')).toBe(true);
  });
});
