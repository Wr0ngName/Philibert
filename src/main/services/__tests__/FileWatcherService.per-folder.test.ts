/**
 * The per-folder watcher Linux uses, against a real folder.
 *
 * Reported: switching to a discussion in a big folder froze the whole window
 * for seconds. Node's recursive fs.watch on Linux sets up one inotify watch
 * per file and folder, synchronously, inside the call — 2 s for 100,000
 * entries — and Electron runs the main process's JavaScript on the thread
 * that takes the window's input. This one walks the tree asynchronously,
 * watches folders only, skips the folders the tree ignores, and returns at
 * once.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { FileChange } from '../../../shared/types';
import { FileWatcherService } from '../FileWatcherService';

let root: string;
let service: FileWatcherService;
let changes: FileChange[];

function mkdirs(...dirs: string[]): void {
  for (const dir of dirs) fs.mkdirSync(path.join(root, dir), { recursive: true });
}

/** The changes reported once the watcher's debounce has passed. */
async function reported(): Promise<FileChange[]> {
  await new Promise((resolve) => setTimeout(resolve, 600));
  return changes;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-watch-'));
  changes = [];
  service = new FileWatcherService({ perFolder: true });
  service.onChange((batch) => changes.push(...batch));
});

afterEach(() => {
  service.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('watching each folder', () => {
  it('returns at once, without a recursive watch, and then watches every folder', async () => {
    mkdirs('src/lib/deep', 'docs');
    const watch = vi.spyOn(fs, 'watch');

    const t0 = performance.now();
    service.watch(root);
    expect(performance.now() - t0).toBeLessThan(50);

    await service.whenWatching();
    expect(service.watchedFolderCount()).toBe(5);
    expect(watch.mock.calls.every((call) => !(call[1] as { recursive?: boolean } | undefined)?.recursive)).toBe(true);
    watch.mockRestore();
  });

  it('leaves out the folders the tree ignores', async () => {
    mkdirs('src', 'node_modules/pkg/lib', '.git/objects');
    service.watch(root);
    await service.whenWatching();

    expect(service.watchedFolderCount()).toBe(2);
    fs.writeFileSync(path.join(root, 'node_modules/pkg/lib/x.js'), 'x');
    expect(await reported()).toEqual([]);
  });

  it('reports a file written deep inside, as a file', async () => {
    mkdirs('src/lib');
    service.watch(root);
    await service.whenWatching();

    fs.writeFileSync(path.join(root, 'src/lib/util.ts'), 'export {}');

    expect(await reported()).toContainEqual({ type: 'add', path: path.join(root, 'src/lib/util.ts'), kind: 'file' });
  });

  it('watches a folder made after it started, and what is written in it', async () => {
    service.watch(root);
    await service.whenWatching();

    fs.mkdirSync(path.join(root, 'new'));
    await reported();
    await service.whenWatching();
    changes = [];
    fs.writeFileSync(path.join(root, 'new/file.txt'), 'hi');

    expect(await reported()).toContainEqual({ type: 'add', path: path.join(root, 'new/file.txt'), kind: 'file' });
  });

  it('stops watching the folder left when another is watched', async () => {
    mkdirs('a', 'b');
    service.watch(path.join(root, 'a'));
    await service.whenWatching();

    service.watch(path.join(root, 'b'));
    await service.whenWatching();
    fs.writeFileSync(path.join(root, 'a/left.txt'), 'x');

    expect(await reported()).toEqual([]);
    expect(service.watchedFolderCount()).toBe(1);
  });

  it('watches nothing once stopped', async () => {
    mkdirs('src');
    service.watch(root);
    await service.whenWatching();

    service.stop();
    fs.writeFileSync(path.join(root, 'src/after.ts'), 'x');

    expect(await reported()).toEqual([]);
    expect(service.watchedFolderCount()).toBe(0);
  });
});
