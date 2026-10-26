/**
 * The Claude CLI's own login, which Philibert shares, and the move away from
 * the separate CLI directory 0.25.0-rc.1/rc.2 used — on a real disk.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  accessTokenOf,
  cliConfigDir,
  dropVanishedCliLogin,
  hasCliLogin,
  migrateFromSeparateCliLogin,
  migrateSeparateConfigDir,
  readCliCredentials,
} from '../cliCredentials';

const LOGIN = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-a', refreshToken: 'sk-ant-ort01-r' } });

describe('cliCredentials', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-creds-'));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe('cliConfigDir', () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    afterEach(() => {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    });

    it("is the CLI's own: ~/.claude, or the CLAUDE_CONFIG_DIR the user set", () => {
      delete process.env.CLAUDE_CONFIG_DIR;
      expect(cliConfigDir()).toBe(path.join(os.homedir(), '.claude'));
      process.env.CLAUDE_CONFIG_DIR = '/srv/claude';
      expect(cliConfigDir()).toBe('/srv/claude');
    });
  });

  it('reads a login, and no login from a missing, half-written or foreign file', () => {
    expect(readCliCredentials(dir)).toBeNull();
    expect(hasCliLogin(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{"claudeAiOau');
    expect(readCliCredentials(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ oauthToken: 'sk-ant-oat01-x' }));
    expect(readCliCredentials(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, '.credentials.json'), LOGIN);
    expect(readCliCredentials(dir)).toBe(LOGIN);
    expect(hasCliLogin(dir)).toBe(true);
  });

  it('gives the access token of a login', () => {
    expect(accessTokenOf(LOGIN)).toBe('sk-ant-oat01-a');
    expect(accessTokenOf('not json')).toBeNull();
  });

  describe('moving out of the separate CLI directory (0.25.0-rc.1/rc.2)', () => {
    let separate: string;
    let cli: string;

    beforeEach(() => {
      separate = path.join(dir, 'claude-config');
      cli = path.join(dir, 'dot-claude');
    });

    function write(file: string, content = 'x'): void {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }

    it('moves its sessions into the CLI projects, so those discussions resume', () => {
      write(path.join(separate, 'projects', '-home-u-proj', 'aaaa.jsonl'), 'rc session');
      write(path.join(separate, 'projects', '-home-u-proj', 'aaaa', 'subagents', 'agent-1.jsonl'));

      const result = migrateSeparateConfigDir(separate, cli);

      expect(result.movedSessions).toBe(1);
      expect(fs.readFileSync(path.join(cli, 'projects', '-home-u-proj', 'aaaa.jsonl'), 'utf8')).toBe('rc session');
      expect(fs.existsSync(path.join(cli, 'projects', '-home-u-proj', 'aaaa', 'subagents', 'agent-1.jsonl'))).toBe(true);
    });

    it('never overwrites a session the CLI already has', () => {
      write(path.join(separate, 'projects', '-p', 'same.jsonl'), 'rc copy');
      write(path.join(cli, 'projects', '-p', 'same.jsonl'), 'the real one');

      migrateSeparateConfigDir(separate, cli);

      expect(fs.readFileSync(path.join(cli, 'projects', '-p', 'same.jsonl'), 'utf8')).toBe('the real one');
    });

    it('removes its separate login, and leaves the CLI login alone', () => {
      write(path.join(separate, '.credentials.json'), LOGIN);
      write(path.join(cli, '.credentials.json'), 'terminal login');

      expect(migrateSeparateConfigDir(separate, cli).hadLogin).toBe(true);
      expect(fs.existsSync(path.join(separate, '.credentials.json'))).toBe(false);
      expect(fs.readFileSync(path.join(cli, '.credentials.json'), 'utf8')).toBe('terminal login');
    });

    it('has nothing to do when that directory never existed, and again once done', () => {
      expect(migrateSeparateConfigDir(separate, cli)).toEqual({ hadLogin: false, movedSessions: 0 });
      write(path.join(separate, 'projects', '-p', 's.jsonl'));
      migrateSeparateConfigDir(separate, cli);
      expect(migrateSeparateConfigDir(separate, cli)).toEqual({ hadLogin: false, movedSessions: 0 });
    });

    it('turns a login made on those builds into the CLI login, dropping the stored copy', async () => {
      write(path.join(separate, '.credentials.json'), LOGIN);
      write(path.join(cli, '.credentials.json'), LOGIN);
      const configService = fakeConfig({ storedCopy: true });

      await withCliDir(cli, () => migrateFromSeparateCliLogin(configService as never, separate));

      expect(configService.forgetStoredCliCredentials).toHaveBeenCalled();
      expect(configService.usesCli).toBe(true);
      expect(configService.setConfig).not.toHaveBeenCalled();
    });

    it('asks for a login when those builds were logged in but the CLI is not', async () => {
      write(path.join(separate, '.credentials.json'), LOGIN);
      const configService = fakeConfig({ storedCopy: true });

      await withCliDir(cli, () => migrateFromSeparateCliLogin(configService as never, separate));

      expect(configService.usesCli).toBe(false);
      expect(configService.setConfig).toHaveBeenCalledWith({ oauthToken: '', authMethod: 'none' });
    });

    it('leaves an install that never ran those builds as it is', async () => {
      const configService = fakeConfig({ storedCopy: false });

      await withCliDir(cli, () => migrateFromSeparateCliLogin(configService as never, separate));

      expect(configService.usesCli).toBe(false);
      expect(configService.setConfig).not.toHaveBeenCalled();
    });
  });

  describe('dropVanishedCliLogin', () => {
    it('logs Philibert out of a CLI login the CLI no longer has', async () => {
      const configService = fakeConfig({ usesCli: true });

      expect(await withCliDir(dir, () => dropVanishedCliLogin(configService as never))).toBe(true);
      expect(configService.usesCli).toBe(false);
      expect(configService.setConfig).toHaveBeenCalledWith({ oauthToken: '', authMethod: 'none' });
    });

    it('keeps a CLI login the CLI has, and leaves a token login alone', async () => {
      fs.writeFileSync(path.join(dir, '.credentials.json'), LOGIN);
      const cliLogin = fakeConfig({ usesCli: true });
      const tokenLogin = fakeConfig({ usesCli: false });

      expect(await withCliDir(dir, () => dropVanishedCliLogin(cliLogin as never))).toBe(false);
      fs.rmSync(path.join(dir, '.credentials.json'));
      expect(await withCliDir(dir, () => dropVanishedCliLogin(tokenLogin as never))).toBe(false);
      expect(cliLogin.setConfig).not.toHaveBeenCalled();
      expect(tokenLogin.setConfig).not.toHaveBeenCalled();
    });
  });
});

/** The parts of ConfigService the login migration uses, recording what it is told. */
function fakeConfig(initial: { storedCopy?: boolean; usesCli?: boolean }) {
  const fake = {
    usesCli: initial.usesCli ?? false,
    forgetStoredCliCredentials: vi.fn(async () => initial.storedCopy ?? false),
    usesCliLogin: vi.fn(async () => fake.usesCli),
    setUsesCliLogin: vi.fn(async (value: boolean) => { fake.usesCli = value; }),
    setConfig: vi.fn(async () => undefined),
  };
  return fake;
}

/** Run with the CLI config directory pointed at `dir`, never the real ~/.claude. */
async function withCliDir<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
}
