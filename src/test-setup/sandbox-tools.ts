/**
 * bubblewrap and socat on the PATH, for a suite whose discussions start
 * sandboxed: a sandboxed discussion is not started on Linux without them
 * (sandboxDependencies), and a CI container has neither. Stand-ins first on
 * the PATH make each test start its discussion whatever this machine has
 * installed. A test of the missing-tools path sets its own PATH; it is put
 * back after each test.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

export function useInstalledSandboxTools(): void {
  const originalPath = process.env.PATH;
  let tools = '';

  beforeAll(() => {
    tools = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-sandbox-tools-'));
    for (const tool of ['bwrap', 'socat']) {
      fs.writeFileSync(path.join(tools, tool), '#!/bin/sh\n', { mode: 0o755 });
    }
  });

  beforeEach(() => {
    process.env.PATH = [tools, originalPath].join(path.delimiter);
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  afterAll(() => {
    fs.rmSync(tools, { recursive: true, force: true });
  });
}
