/**
 * A git server over HTTP that requires a login, for tests: `git
 * http-backend` (git's own smart-HTTP server, run as CGI) behind a Node HTTP
 * server checking Basic auth. Real pushes and pulls, needing a real login,
 * without a network.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface GitHttpServer {
  /** Base URL; a repository at <projectRoot>/x.git is `${url}/x.git`. */
  url: string;
  /** host:port, as git names it in a credential request. */
  host: string;
  /** Requests turned away for a wrong or missing login. */
  refused: number;
  close(): Promise<void>;
}

export async function startGitHttpServer(
  projectRoot: string,
  login: { username: string; password: string },
): Promise<GitHttpServer> {
  const expected = `Basic ${Buffer.from(`${login.username}:${login.password}`).toString('base64')}`;
  const state = { refused: 0 };

  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== expected) {
      state.refused += 1;
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' });
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const backend = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        GATEWAY_INTERFACE: 'CGI/1.1',
        REQUEST_METHOD: req.method ?? 'GET',
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_USER: login.username,
        REMOTE_ADDR: '127.0.0.1',
        ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {}),
      },
    });
    req.pipe(backend.stdin);

    // CGI output: headers, a blank line, then the body.
    let head = Buffer.alloc(0);
    let headersDone = false;
    backend.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) {
        res.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      headersDone = true;
      let status = 200;
      for (const line of head.subarray(0, end).toString().split('\r\n')) {
        const at = line.indexOf(':');
        if (at < 0) continue;
        const name = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
        else res.setHeader(name, value);
      }
      res.statusCode = status;
      res.write(head.subarray(end + 4));
    });
    backend.on('close', () => res.end());
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    get refused() {
      return state.refused;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
