/**
 * The CLI's login files in Philibert's config directory, on a real disk.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../utils/resourcePaths', () => ({ getClaudeConfigDir: () => '/unused' }));

import {
  accessTokenOf,
  mergeOAuthAccount,
  readCliCredentials,
  readOAuthAccount,
  removeCliCredentials,
  writeCliCredentials,
} from '../cliCredentials';

const LOGIN = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-a', refreshToken: 'sk-ant-ort01-r' } });

describe('cliCredentials', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-creds-'));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes the credentials readable by this user only, and reads them back', () => {
    writeCliCredentials(LOGIN, dir);

    expect(readCliCredentials(dir)).toBe(LOGIN);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dir, '.credentials.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('reads no login from a missing, half-written or foreign file', () => {
    expect(readCliCredentials(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{"claudeAiOau');
    expect(readCliCredentials(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ oauthToken: 'sk-ant-oat01-x' }));
    expect(readCliCredentials(dir)).toBeNull();
  });

  it('removes the credentials, and is fine when there are none', () => {
    writeCliCredentials(LOGIN, dir);
    removeCliCredentials(dir);
    expect(readCliCredentials(dir)).toBeNull();
    expect(() => removeCliCredentials(dir)).not.toThrow();
  });

  it('gives the access token of a login', () => {
    expect(accessTokenOf(LOGIN)).toBe('sk-ant-oat01-a');
    expect(accessTokenOf('not json')).toBeNull();
  });

  it("adds the account to the CLI's own config, keeping everything else in it", () => {
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ userID: 'u', projects: { '/p': { a: 1 } } }));

    mergeOAuthAccount(JSON.stringify({ emailAddress: 'someone@example.com' }), dir);

    const config = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
    expect(config).toEqual({ userID: 'u', projects: { '/p': { a: 1 } }, oauthAccount: { emailAddress: 'someone@example.com' } });
    expect(readOAuthAccount(dir)).toBe(JSON.stringify({ emailAddress: 'someone@example.com' }));
  });

  it('starts the config when there is none yet', () => {
    mergeOAuthAccount(JSON.stringify({ emailAddress: 'someone@example.com' }), dir);
    expect(readOAuthAccount(dir)).toBe(JSON.stringify({ emailAddress: 'someone@example.com' }));
  });

  it('reads no account from a config without one', () => {
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ userID: 'u' }));
    expect(readOAuthAccount(dir)).toBeNull();
  });
});
