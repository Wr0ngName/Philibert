/**
 * The sandbox settings the CLI is started with, and what the app's lists
 * take: what the probes against CLI 2.1.280 showed each setting to do is
 * recorded where they are defined (@shared/sandbox).
 */

import { describe, it, expect } from 'vitest';

import { cleanSandboxPreferences, cliSandboxSettings, isSandboxDomain, isSandboxPath, networkRuleContent, sandboxOnByDefault } from '../sandbox';

describe('cliSandboxSettings', () => {
  it('confines a sandboxed discussion with no way out, every command still asked, and no start without it', () => {
    expect(cliSandboxSettings(true, { enabledByDefault: true, allowedDomains: ['example.com'], allowWrite: ['~/.npm'] })).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      network: { allowedDomains: ['example.com'] },
      filesystem: { allowWrite: ['~/.npm'] },
    });
  });

  it('turns the sandbox off for an unsandboxed one, rather than leaving it to other settings', () => {
    expect(cliSandboxSettings(false, { enabledByDefault: true, allowedDomains: ['example.com'], allowWrite: [] })).toEqual({ enabled: false });
  });
});

describe('the sandbox lists', () => {
  it('take host names, and subdomains with *.', () => {
    expect(['example.com', 'registry.npmjs.org', '*.github.com', 'localhost'].every(isSandboxDomain)).toBe(true);
    expect(['https://example.com', 'example.com/x', 'example.com:443', '*example.com', 'a..b', ''].some(isSandboxDomain)).toBe(false);
  });

  it('take absolute paths and paths from the home folder', () => {
    expect(['/srv/cache', '~/.npm', '~', 'C:\\cache', 'D:/cache'].every(isSandboxPath)).toBe(true);
    expect(['relative', './here', '~user/x'].some(isSandboxPath)).toBe(false);
  });

  it('are cleaned: trimmed, once each, the invalid left out', () => {
    expect(cleanSandboxPreferences({ enabledByDefault: true, allowedDomains: [' a.com', 'a.com', 'nope/'], allowWrite: ['/x', '/x ', 'y'] }))
      .toEqual({ enabledByDefault: true, allowedDomains: ['a.com'], allowWrite: ['/x'] });
  });
});

describe('the defaults', () => {
  it('are on everywhere but Windows', () => {
    expect([sandboxOnByDefault('linux'), sandboxOnByDefault('darwin'), sandboxOnByDefault('win32')]).toEqual([true, true, false]);
  });

  it('grant a host as the WebFetch domain rule the CLI opens it for', () => {
    expect(networkRuleContent('example.com')).toBe('domain:example.com');
  });
});
