/**
 * What a sandboxed discussion needs installed, found on the PATH as the CLI
 * finds it — real files in a scratch folder, no mocks.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { missingSandboxTools, sandboxUnavailableNotice } from '../sandboxDependencies';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-path-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function install(name: string, mode = 0o755): void {
  fs.writeFileSync(path.join(dir, name), '#!/bin/sh\n', { mode });
}

describe('missingSandboxTools', () => {
  it('finds bubblewrap and socat on the PATH on Linux', () => {
    install('bwrap');
    install('socat');

    expect(missingSandboxTools('linux', ['/nonexistent', dir].join(path.delimiter))).toEqual([]);
  });

  it('names each one that is not there', () => {
    install('socat');

    expect(missingSandboxTools('linux', dir)).toEqual(['bwrap']);
    expect(missingSandboxTools('linux', '')).toEqual(['bwrap', 'socat']);
  });

  it('does not count a file that cannot be run', () => {
    install('bwrap', 0o644);
    install('socat');

    expect(missingSandboxTools('linux', dir)).toEqual(['bwrap']);
  });

  it('needs nothing installed on macOS, nor on Windows, where the CLI checks its own setup', () => {
    expect(missingSandboxTools('darwin', '')).toEqual([]);
    expect(missingSandboxTools('win32', '')).toEqual([]);
  });
});

describe('sandboxUnavailableNotice', () => {
  it('says what is missing, how to install it, and the way to go on without the sandbox', () => {
    expect(sandboxUnavailableNotice(['bwrap'])).toBe(
      'This discussion runs shell commands in a sandbox, and the sandbox cannot start: bwrap is not installed. '
      + 'Install it (for example: sudo apt install bubblewrap socat), or turn the sandbox off for this discussion '
      + 'in its permissions menu (the shield) — its commands then run unrestricted.',
    );
    expect(sandboxUnavailableNotice(['bwrap', 'socat'])).toContain('bwrap and socat are not installed. Install them');
  });
});
