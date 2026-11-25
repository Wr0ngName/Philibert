/**
 * Where a rewound conversation resumes, read from the session's transcript:
 * the cases its contract test (rewind.cli.test.ts) does not reach.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resumePointBefore } from '../rewind-point';

let dir: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-point-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function transcript(lines: string[]): string {
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

describe('resumePointBefore', () => {
  it("is never found through another entry naming the id: a call's answer, as its result's parent", () => {
    // The result of a call is a `user` entry whose parent is Claude's answer
    // that made the call: that answer is not a prompt to rewind to.
    const file = transcript([
      JSON.stringify({ type: 'user', uuid: 'prompt', parentUuid: null }),
      JSON.stringify({ type: 'assistant', uuid: 'answer', parentUuid: 'prompt' }),
      JSON.stringify({ type: 'user', uuid: 'result', parentUuid: 'answer' }),
    ]);

    return expect(resumePointBefore(file, 'answer')).resolves.toBeUndefined();
  });

  it('reads past a line it cannot parse, as one the CLI is still writing', async () => {
    const file = transcript([
      '{"type":"user","uuid":"broken prompt", "parentUuid"',
      JSON.stringify({ type: 'assistant', uuid: 'answer', parentUuid: null }),
      JSON.stringify({ type: 'user', uuid: 'prompt', parentUuid: 'answer' }),
    ]);

    await expect(resumePointBefore(file, 'prompt')).resolves.toBe('answer');
  });
});
