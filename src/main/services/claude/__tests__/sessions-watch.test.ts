/**
 * Watching Claude Code's session transcripts for being deleted, against a
 * real folder and the real fs.watch.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ClaudeSessionsWatch, SESSIONS_RESCAN_DELAY_MS } from '../sessions-watch';

let configDir: string;
let deleted: string[][];
let watch: ClaudeSessionsWatch;

const projects = () => path.join(configDir, 'projects');
const transcript = (project: string, sessionId: string) => path.join(projects(), project, `${sessionId}.jsonl`);
function sessionOnDisk(project: string, sessionId: string): void {
  fs.mkdirSync(path.join(projects(), project), { recursive: true });
  fs.writeFileSync(transcript(project, sessionId), '{}\n');
}
/** Long enough for a change to be seen and its folder listed. */
const seen = () => new Promise((resolve) => setTimeout(resolve, SESSIONS_RESCAN_DELAY_MS * 3));

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-watch-'));
  deleted = [];
  watch = new ClaudeSessionsWatch((sessionIds) => deleted.push(sessionIds), () => configDir);
});

afterEach(() => {
  watch.stop();
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("watching Claude Code's sessions", () => {
  it('reports a deleted transcript, once', async () => {
    sessionOnDisk('-p1', 's1');
    sessionOnDisk('-p1', 's2');
    sessionOnDisk('-p2', 's3');
    expect(watch.start()).toBe(true);

    fs.rmSync(transcript('-p1', 's1'));
    fs.rmSync(transcript('-p2', 's3'));

    await vi.waitFor(() => expect(deleted.flat().sort()).toEqual(['s1', 's3']));
    await seen();
    expect(deleted.flat().sort()).toEqual(['s1', 's3']);
  });

  it('says nothing while transcripts are written to, or new ones come', async () => {
    sessionOnDisk('-p1', 's1');
    watch.start();

    fs.appendFileSync(transcript('-p1', 's1'), '{"more":1}\n');
    sessionOnDisk('-p1', 's2');
    await seen();

    expect(deleted).toEqual([]);
  });

  it('watches a project folder that comes after it started', async () => {
    fs.mkdirSync(projects());
    watch.start();

    sessionOnDisk('-new', 's1');
    await seen();
    fs.rmSync(transcript('-new', 's1'));

    await vi.waitFor(() => expect(deleted.flat()).toEqual(['s1']));
  });

  it("reports a whole project folder's sessions when it is removed", async () => {
    sessionOnDisk('-p1', 's1');
    sessionOnDisk('-p1', 's2');
    watch.start();

    fs.rmSync(path.join(projects(), '-p1'), { recursive: true });

    await vi.waitFor(() => expect(deleted.flat().sort()).toEqual(['s1', 's2']));
    await seen();
    expect(deleted.flat().sort()).toEqual(['s1', 's2']);
  });

  it('starts only once Claude Code has a projects folder', async () => {
    expect(watch.start()).toBe(false);

    sessionOnDisk('-p1', 's1');
    expect(watch.start()).toBe(true);
    fs.rmSync(transcript('-p1', 's1'));

    await vi.waitFor(() => expect(deleted.flat()).toEqual(['s1']));
  });

  it('reports nothing once stopped', async () => {
    sessionOnDisk('-p1', 's1');
    watch.start();
    watch.stop();

    fs.rmSync(transcript('-p1', 's1'));
    await seen();

    expect(deleted).toEqual([]);
  });
});
