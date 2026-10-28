/**
 * Asking the user for a git login when a push or pull needs one.
 *
 * Git is run without a terminal, so when it needs a login and none of the
 * user's own credential helpers has one, it can only fail ("could not read
 * Username ... No such device or address"). For a push or pull, Philibert
 * adds its own helper after the user's (git-credential-helper.mjs): git asks
 * the user's helpers first, as usual, and only when none of them answers
 * does it ask Philibert's — which asks the user in the app.
 *
 * Git's credential protocol is the whole interface: `get` for a login,
 * `store` when it worked (git also stores it in the user's helpers, which is
 * how the login is remembered), `erase` when the server refused it. Each
 * push or pull is an operation; what happened to its login is read from
 * those calls, not from git's wording.
 *
 * The helper reaches this broker through a local socket (a named pipe on
 * Windows) and a random token, both passed only to that git process.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { GitCredentialAnswer, GitCredentialRequest, GitRemoteResult } from '../../../shared/types';
import logger from '../../utils/logger';

import helperSource from './git-credential-helper.mjs?raw';

/** Asks the user for a login; null when they cancel. */
export type CredentialAsker = (request: GitCredentialRequest) => Promise<GitCredentialAnswer | null>;

export type GitAuthFailure = NonNullable<Extract<GitRemoteResult, { ok: false }>['auth']>;

/** What a push or pull needs to let Philibert ask for its login. */
export interface CredentialSession {
  /** `-c` options to put before the git command. */
  configArgs: string[];
  /** Variables to add to that git process's environment. */
  env: Record<string, string>;
  /** Why the login failed, when it did: cancelled by the user, or refused. */
  authFailure(): GitAuthFailure | null;
  /** The operation is over; requests for it are no longer answered. */
  end(): void;
}

interface Operation {
  host?: string;
  cancelled: boolean;
  rejected: boolean;
}

interface HelperMessage {
  token?: unknown;
  operation?: unknown;
  action?: unknown;
  attributes?: Record<string, unknown>;
}

const SOCKET_PREFIX = 'philibert-git-';
const SOCKET_NAME = /^philibert-git-(\d+)-[0-9a-f]+\.sock$/;

/**
 * Remove the sockets of Philibert processes that are gone. A socket file
 * outlives a process that did not shut down cleanly (killed, crashed), and
 * each run would otherwise leave one more in the temp directory. Those of a
 * Philibert still running are left: its pushes are using them.
 */
export function removeStaleSockets(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(SOCKET_NAME.exec(name)?.[1]);
    if (!pid || pid === process.pid || isRunning(pid)) continue;
    fs.rmSync(path.join(dir, name), { force: true });
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, under another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Quote for sh, which runs git's `!` credential helpers (Git for Windows' too). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class GitCredentialBroker {
  private server: net.Server | null = null;
  private starting: Promise<void> | null = null;
  private socketPath = '';
  private helperPath = '';
  private readonly token = crypto.randomBytes(32).toString('hex');
  private readonly operations = new Map<string, Operation>();
  private asker: CredentialAsker | null = null;

  /**
   * @param helperDir Where the helper script is written (userData).
   * @param nodeExecutable What runs it as Node: Philibert's own executable,
   *   with ELECTRON_RUN_AS_NODE.
   */
  constructor(
    private readonly helperDir: string,
    private readonly nodeExecutable: string = process.execPath,
  ) {}

  /** Who asks the user. Without one, every request is answered as cancelled. */
  setAsker(asker: CredentialAsker): void {
    this.asker = asker;
  }

  /** Start an operation (a push or pull) that may ask for a login. */
  async begin(): Promise<CredentialSession> {
    await this.start();
    const id = crypto.randomUUID();
    const operation: Operation = { cancelled: false, rejected: false };
    this.operations.set(id, operation);

    // Paths in forward slashes: Git for Windows runs the helper through its
    // own sh, which takes them that way.
    const exe = this.nodeExecutable.replace(/\\/g, '/');
    const script = this.helperPath.replace(/\\/g, '/');
    return {
      configArgs: ['-c', `credential.helper=!ELECTRON_RUN_AS_NODE=1 ${shellQuote(exe)} ${shellQuote(script)}`],
      env: {
        PHILIBERT_GIT_CREDENTIAL_SOCKET: this.socketPath,
        PHILIBERT_GIT_CREDENTIAL_TOKEN: this.token,
        PHILIBERT_GIT_OPERATION: id,
      },
      authFailure: () => {
        const host = operation.host ?? '';
        if (operation.cancelled) return { host, reason: 'cancelled' };
        if (operation.rejected) return { host, reason: 'rejected' };
        return null;
      },
      end: () => {
        this.operations.delete(id);
      },
    };
  }

  /** Stop listening and remove the socket. */
  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.starting = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== 'win32' && this.socketPath) fs.rmSync(this.socketPath, { force: true });
  }

  private start(): Promise<void> {
    if (!this.starting) {
      this.starting = this.listen().catch((error: unknown) => {
        this.starting = null;
        throw error;
      });
    }
    return this.starting;
  }

  private async listen(): Promise<void> {
    fs.mkdirSync(this.helperDir, { recursive: true });
    this.helperPath = path.join(this.helperDir, 'git-credential-helper.mjs');
    // Written on every start, so it is the version this build ships.
    fs.writeFileSync(this.helperPath, helperSource, { mode: 0o600 });

    const name = `${SOCKET_PREFIX}${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    this.socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\${name}`
      : path.join(os.tmpdir(), `${name}.sock`);
    if (process.platform !== 'win32') removeStaleSockets(os.tmpdir());

    const server = net.createServer((socket) => this.serve(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') fs.chmodSync(this.socketPath, 0o600);
    this.server = server;
    logger.info('Git credential broker listening');
  }

  private serve(socket: net.Socket): void {
    let received = '';
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: string) => {
      received += chunk;
      const end = received.indexOf('\n');
      if (end < 0) return;
      void this.answer(received.slice(0, end)).then(
        (reply) => socket.end(JSON.stringify(reply)),
        () => socket.end('{}'),
      );
    });
  }

  private async answer(line: string): Promise<Record<string, unknown>> {
    let message: HelperMessage;
    try {
      message = JSON.parse(line) as HelperMessage;
    } catch {
      return {};
    }
    if (typeof message.token !== 'string' || !this.isToken(message.token)) {
      logger.warn('Git credential request with a wrong token, ignored');
      return {};
    }
    const operation = typeof message.operation === 'string' ? this.operations.get(message.operation) : undefined;
    if (!operation) return {};

    const attributes = message.attributes ?? {};
    const host = typeof attributes.host === 'string' ? attributes.host : '';
    if (host) operation.host = host;

    if (message.action === 'erase') {
      // Git refused the login it was given — the one entered here, or one a
      // helper of the user's kept and that no longer works.
      operation.rejected = true;
      logger.info('Git login refused', { host });
      return {};
    }
    if (message.action !== 'get') return {};

    const request: GitCredentialRequest = {
      requestId: crypto.randomUUID(),
      protocol: typeof attributes.protocol === 'string' ? attributes.protocol : '',
      host,
      ...(typeof attributes.username === 'string' && attributes.username ? { username: attributes.username } : {}),
    };
    const answer = this.asker ? await this.asker(request) : null;
    // A value with a line break would end git's key=value line early.
    if (!answer || /[\r\n]/.test(answer.username + answer.password)) {
      operation.cancelled = true;
      return { quit: true };
    }
    return { username: answer.username, password: answer.password };
  }

  private isToken(candidate: string): boolean {
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}
