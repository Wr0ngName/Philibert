/**
 * Watching the open discussion's session transcript, against a real folder
 * and the real fs.watch: Claude Code deleting it is reported at once.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SessionTranscriptWatch } from '../session-watch';

let configDir: string;
let gone: string[];
let watch: SessionTranscriptWatch;

const transcript = (sessionId: string) => path.join(configDir, 'projects', '-project', `${sessionId}.jsonl`);
function sessionOnDisk(sessionId: string): void {
  fs.mkdirSync(path.dirname(transcript(sessionId)), { recursive: true });
  fs.writeFileSync(transcript(sessionId), '{}\n');
}
/** Long enough for an fs event that would come to have come. */
const quiet = () => new Promise((resolve) => setTimeout(resolve, 300));

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-'));
  gone = [];
  watch = new SessionTranscriptWatch((conversationId) => gone.push(conversationId), () => configDir);
});

afterEach(() => {
  watch.stop();
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('watching the open discussion', () => {
  it('reports it gone once, as soon as its transcript is deleted', async () => {
    sessionOnDisk('s1');
    watch.watch('c1', 's1');

    fs.rmSync(transcript('s1'));

    await vi.waitFor(() => expect(gone).toEqual(['c1']));
    await quiet();
    expect(gone).toEqual(['c1']);
  });

  it('says nothing while the transcript is written to', async () => {
    sessionOnDisk('s1');
    watch.watch('c1', 's1');

    fs.appendFileSync(transcript('s1'), '{"more":1}\n');
    await quiet();

    expect(gone).toEqual([]);
  });

  it('stops watching one no longer open', async () => {
    sessionOnDisk('s1');
    sessionOnDisk('s2');
    watch.watch('c1', 's1');
    watch.watch('c2', 's2');

    fs.rmSync(transcript('s1'));
    await quiet();
    expect(gone).toEqual([]);

    fs.rmSync(transcript('s2'));
    await vi.waitFor(() => expect(gone).toEqual(['c2']));
  });

  it('does not take a transcript not written yet as gone, and watches it once it is', async () => {
    watch.watch('new', 'fresh');
    await quiet();
    expect(gone).toEqual([]);

    sessionOnDisk('fresh');
    watch.watch('new', 'fresh');
    fs.rmSync(transcript('fresh'));

    await vi.waitFor(() => expect(gone).toEqual(['new']));
  });

  it('watches nothing for a discussion with no session', async () => {
    sessionOnDisk('s1');
    watch.watch('c1', 's1');
    watch.watch('c1', null);

    fs.rmSync(transcript('s1'));
    await quiet();
    expect(gone).toEqual([]);
  });
});
