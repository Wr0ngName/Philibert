/**
 * Signing in during a push or pull, end to end: real git, pushing over HTTP
 * to a real git server that requires a login (git http-backend), with
 * Philibert's credential helper and broker in between. Only the user is
 * stood in for — the asker answers as they would.
 *
 * Git's configuration is isolated from the machine's: an empty global
 * config and no system config, so no credential helper of the developer's
 * is ever asked or written to. The "user's own helper" is a `store` file in
 * the test's directory.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../utils/resourcePaths', () => ({
  WindowsPaths: {
    hasBundledGit: () => false,
    getGitExe: () => 'git',
    hasBundledGitBash: () => false,
    buildEnhancedPath: () => process.env.PATH || '',
  },
}));

vi.mock('../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { GitCredentialAnswer, GitCredentialRequest } from '../../../shared/types';
import { GitService } from '../GitService';
import { GitCredentialBroker, removeStaleSockets } from '../git/GitCredentialBroker';

import { startGitHttpServer, type GitHttpServer } from './support/git-http-server';

const execFileAsync = promisify(execFile);
const LOGIN = { username: 'alice', password: 'glpat-right-token' };

describe('signing in for a push or pull', () => {
  let dir: string;
  let work: string;
  let storeFile: string;
  let server: GitHttpServer;
  let broker: GitCredentialBroker;
  let service: GitService;
  let asked: GitCredentialRequest[];
  let reply: GitCredentialAnswer | null;
  const savedEnv = { ...process.env };

  async function git(args: string[], cwd = work): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim();
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sign-in-'));
    // Nothing of the developer's machine: no global or system git config.
    process.env.GIT_CONFIG_GLOBAL = path.join(dir, 'empty-gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');

    const projects = path.join(dir, 'server');
    fs.mkdirSync(projects);
    await git(['init', '-q', '--bare', '-b', 'main', path.join(projects, 'repo.git')], dir);
    server = await startGitHttpServer(projects, LOGIN);

    work = path.join(dir, 'work');
    fs.mkdirSync(work);
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.name', 'Test']);
    await git(['config', 'user.email', 'test@example.com']);
    // The user's own credential helper: where a login that worked is kept.
    storeFile = path.join(dir, 'stored-credentials');
    await git(['config', 'credential.helper', `store --file=${storeFile}`]);
    await git(['remote', 'add', 'origin', `${server.url}/repo.git`]);
    fs.writeFileSync(path.join(work, 'a.txt'), 'a');
    await git(['add', 'a.txt']);
    await git(['commit', '-q', '-m', 'first']);
    await git(['config', 'push.default', 'current']);

    asked = [];
    reply = LOGIN;
    broker = new GitCredentialBroker(path.join(dir, 'helper'), process.execPath);
    broker.setAsker(async (request) => {
      asked.push(request);
      return reply;
    });
    service = new GitService(broker);
  });

  afterEach(async () => {
    await broker.close();
    await server.close();
    process.env = { ...savedEnv };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function serverHasCommit(): Promise<boolean> {
    const heads = await git(['ls-remote', path.join(dir, 'server', 'repo.git')], dir);
    return heads.includes('refs/heads/main');
  }

  it('asks the user when no helper has a login, pushes with it, and the user\'s helper keeps it', async () => {
    const result = await service.push(work);

    expect(result).toMatchObject({ ok: true });
    expect(asked).toEqual([expect.objectContaining({ protocol: 'http', host: server.host })]);
    expect(await serverHasCommit()).toBe(true);
    // git-credential-store URL-encodes the port's colon.
    expect(fs.readFileSync(storeFile, 'utf8').trim())
      .toBe(`http://alice:${LOGIN.password}@${server.host.replace(':', '%3a')}`);
  });

  it('does not ask again once the user\'s helper has the login', async () => {
    await service.push(work);
    fs.writeFileSync(path.join(work, 'b.txt'), 'b');
    await git(['add', 'b.txt']);
    await git(['commit', '-q', '-m', 'second']);

    expect(await service.push(work)).toMatchObject({ ok: true });
    expect(asked).toHaveLength(1);
  });

  it('says the sign-in was cancelled when the user cancels, and pushes nothing', async () => {
    reply = null;

    const result = await service.push(work);

    expect(result).toMatchObject({ ok: false, auth: { host: server.host, reason: 'cancelled' } });
    expect(await serverHasCommit()).toBe(false);
  });

  it('says the server refused the login when it is wrong, and keeps nothing', async () => {
    reply = { username: 'alice', password: 'wrong' };

    const result = await service.push(work);

    expect(result).toMatchObject({ ok: false, auth: { host: server.host, reason: 'rejected' } });
    expect(await serverHasCommit()).toBe(false);
    expect(fs.existsSync(storeFile) ? fs.readFileSync(storeFile, 'utf8') : '').toBe('');
  });

  it('when the saved login no longer works (token revoked), says it was refused, drops it, and asks on the next try', async () => {
    await service.push(work);
    // The user's helper still holds the old token; the server no longer
    // takes it.
    fs.writeFileSync(storeFile, `http://alice:glpat-revoked@${server.host.replace(':', '%3a')}\n`);
    asked = [];
    fs.writeFileSync(path.join(work, 'b.txt'), 'b');
    await git(['add', 'b.txt']);
    await git(['commit', '-q', '-m', 'second']);

    const refused = await service.push(work);

    // Git used the saved token without asking anyone, the server refused
    // it, and git told every helper to forget it.
    expect(refused).toMatchObject({ ok: false, auth: { host: server.host, reason: 'rejected' } });
    expect(asked).toHaveLength(0);
    expect(fs.readFileSync(storeFile, 'utf8').trim()).toBe('');

    // Try again: nothing saved now, so the user is asked, and the new token
    // is kept.
    const retried = await service.push(work);

    expect(retried).toMatchObject({ ok: true });
    expect(asked).toHaveLength(1);
    expect(fs.readFileSync(storeFile, 'utf8')).toContain(`alice:${LOGIN.password}@`);
  });

  it('pulls the same way', async () => {
    await service.push(work);
    await git(['branch', '--set-upstream-to', 'origin/main']);
    asked = [];
    fs.rmSync(storeFile);

    const result = await service.pull(work);

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(asked).toHaveLength(1);
  });

  it('never asks from a background fetch: it fails quietly, at once', async () => {
    const started = Date.now();

    await service.fetch(work);

    expect(asked).toHaveLength(0);
    expect(server.refused).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('removes the sockets left by Philibert processes that are gone, and no other file', () => {
    const tmp = path.join(dir, 'tmp');
    fs.mkdirSync(tmp);
    const gone = 'philibert-git-2147483646-abcdef012345.sock';
    const running = `philibert-git-${process.ppid}-abcdef012345.sock`;
    const other = 'philibert-git-notes.txt';
    for (const name of [gone, running, other]) fs.writeFileSync(path.join(tmp, name), '');

    removeStaleSockets(tmp);

    expect(fs.readdirSync(tmp).sort()).toEqual([other, running].sort());
  });

  it('answers nothing to a request without the token', async () => {
    const session = await broker.begin();
    const reply_ = await new Promise<string>((resolve) => {
      const socket = net.connect(session.env.PHILIBERT_GIT_CREDENTIAL_SOCKET);
      let data = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(`${JSON.stringify({
        token: 'not-the-token',
        operation: session.env.PHILIBERT_GIT_OPERATION,
        action: 'get',
        attributes: { protocol: 'http', host: server.host },
      })}\n`));
      socket.on('data', (chunk: string) => { data += chunk; });
      socket.on('end', () => resolve(data));
    });
    session.end();

    expect(JSON.parse(reply_)).toEqual({});
    expect(asked).toHaveLength(0);
  });
});
