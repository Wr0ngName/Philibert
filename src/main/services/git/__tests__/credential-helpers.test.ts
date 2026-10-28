/**
 * Which credential helpers will keep a login, read the way git reads its
 * configuration.
 */

import { describe, it, expect } from 'vitest';

import { describeHelper, effectiveHelpers, keepsLogin, parseHelperConfig } from '../credential-helpers';

describe('effectiveHelpers', () => {
  it('lists helpers in config order, an empty value clearing the ones before it', () => {
    expect(effectiveHelpers([
      { scope: '', value: 'manager' },
      { scope: '', value: '' },
      { scope: '', value: 'store' },
      { scope: '', value: 'cache --timeout=60' },
    ], 'gitlab.example.com')).toEqual(['store', 'cache --timeout=60']);
  });

  it('counts a host-specific helper for its own host only', () => {
    const configured = [
      { scope: '', value: 'cache' },
      { scope: 'https://gitlab.example.com', value: 'store' },
      { scope: 'https://github.com', value: 'osxkeychain' },
    ];
    expect(effectiveHelpers(configured, 'gitlab.example.com')).toEqual(['cache', 'store']);
    expect(effectiveHelpers(configured, 'other.example.com')).toEqual(['cache']);
  });

  it('is empty when none is set up', () => {
    expect(effectiveHelpers([], 'gitlab.example.com')).toEqual([]);
  });
});

describe('parseHelperConfig', () => {
  it('reads `git config --get-regexp` lines, an empty value included', () => {
    expect(parseHelperConfig([
      'credential.helper manager',
      'credential.helper ',
      'credential.https://gitlab.example.com.helper store --file=/home/u/.creds',
      '',
    ].join('\n'))).toEqual([
      { scope: '', value: 'manager' },
      { scope: '', value: '' },
      { scope: 'https://gitlab.example.com', value: 'store --file=/home/u/.creds' },
    ]);
  });
});

describe('describeHelper', () => {
  it('names the helpers people use, whatever form the config gives them in', () => {
    expect(describeHelper('manager')).toBe('Git Credential Manager');
    // A path with a space is quoted or escaped in the config: git runs it
    // through a shell.
    expect(describeHelper('"C:/Program Files/Git/mingw64/bin/git-credential-manager.exe"')).toBe('Git Credential Manager');
    expect(describeHelper('C:/Program\\ Files/Git/mingw64/bin/git-credential-manager.exe')).toBe('Git Credential Manager');
    expect(describeHelper('store --file=/home/u/.creds')).toBe('git-credential-store (a plain-text file)');
    expect(describeHelper('/usr/lib/git-core/git-credential-libsecret')).toBe('the system keyring');
    expect(describeHelper('osxkeychain')).toBe('the macOS Keychain');
    expect(describeHelper('!f() { echo; }; f')).toBe('f()');
  });
});

describe('keepsLogin', () => {
  it('is false for no helper, or only the in-memory cache', () => {
    expect(keepsLogin([])).toBe(false);
    expect(keepsLogin(['cache --timeout=3600'])).toBe(false);
    expect(keepsLogin(['cache', 'store'])).toBe(true);
  });
});
