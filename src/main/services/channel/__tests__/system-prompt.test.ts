/**
 * The system prompt a channel-mode session starts the CLI with
 * (@shared/system-prompt): the instructions in a file of the session's
 * folder, named by the CLI's own flags. A file rather than the text as an
 * argument, which node-pty would split on Windows. What the CLI makes of
 * each flag is pinned against the real CLI in
 * claude/__tests__/system-prompt-options.cli.test.ts.
 *
 * Real: the session, writing its files in a temporary folder. Mocked, as
 * external boundaries: electron, the logger, resource paths, and node-pty —
 * a terminal that records how it was started.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sessions, spawnPty } = vi.hoisted(() => ({
  sessions: { root: '' },
  // A terminal that exits when killed, telling whoever listens then or after.
  spawnPty: vi.fn(() => {
    const exits: (() => void)[] = [];
    let exited = false;
    return {
      pid: 4242,
      onData: () => ({ dispose() {} }),
      onExit: (callback: () => void) => {
        if (exited) callback();
        else exits.push(callback);
        return { dispose() {} };
      },
      write: vi.fn(),
      resize: vi.fn(),
      kill: () => {
        exited = true;
        exits.splice(0).forEach((exit) => exit());
      },
    };
  }),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test'), getName: vi.fn(() => 'test') },
}));

vi.mock('../../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../utils/resourcePaths', () => ({
  getChannelSessionsDir: () => sessions.root,
  WindowsPaths: { getBundledNodeExe: () => '' },
}));

vi.mock('node-pty', () => ({ spawn: spawnPty }));

import type { SystemPromptChoice } from '../../../../shared/system-prompt';
import { ChannelSession } from '../ChannelSession';

const CONVERSATION = 'conversation-1';
let root: string;
let session: ChannelSession | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-channel-prompt-'));
  sessions.root = path.join(root, 'sessions');
  spawnPty.mockClear();
});

afterEach(async () => {
  await session?.stop();
  session = null;
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

/** The CLI's arguments for a session started with the choice. */
async function startWith(systemPrompt: SystemPromptChoice): Promise<string[]> {
  session = new ChannelSession({
    conversationId: CONVERSATION,
    workingDirectory: root,
    claudeCliPath: '/bundled/claude',
    bridgeUrl: 'http://127.0.0.1:1',
    bridgeToken: 'token',
    channelServerScript: '/channel-server.cjs',
    model: '',
    // Its own config folder: never the user's.
    authEnv: { CLAUDE_CONFIG_DIR: path.join(root, 'claude-config') },
    thinkingMode: 'auto',
    effortLevel: null,
    systemPrompt,
  });
  await session.start();
  expect(spawnPty).toHaveBeenCalledTimes(1);
  return (spawnPty.mock.calls[0] as unknown as [string, string[]])[1];
}

const promptFile = () => path.join(sessions.root, CONVERSATION, 'system-prompt.md');
const INSTRUCTIONS = '"Answer in French" and\nkeep it short.';

describe('a channel session starts the CLI', () => {
  it("on its own prompt, with no flag, when it is Claude Code's and there are no instructions", async () => {
    const args = await startWith({ claudeCodePrompt: true, instructions: '' });

    expect(args.filter((arg) => arg.includes('system-prompt'))).toEqual([]);
    expect(fs.existsSync(promptFile())).toBe(false);
  });

  it("on its own prompt, then the instructions' file", async () => {
    const args = await startWith({ claudeCodePrompt: true, instructions: INSTRUCTIONS });

    expect(args.slice(args.indexOf('--append-system-prompt-file'), args.indexOf('--append-system-prompt-file') + 2))
      .toEqual(['--append-system-prompt-file', promptFile()]);
    expect(args).not.toContain('--system-prompt-file');
    expect(fs.readFileSync(promptFile(), 'utf-8')).toBe(INSTRUCTIONS);
  });

  it("without Claude Code's prompt, on the instructions' file in its place", async () => {
    const args = await startWith({ claudeCodePrompt: false, instructions: INSTRUCTIONS });

    expect(args.slice(args.indexOf('--system-prompt-file'), args.indexOf('--system-prompt-file') + 2))
      .toEqual(['--system-prompt-file', promptFile()]);
    expect(fs.readFileSync(promptFile(), 'utf-8')).toBe(INSTRUCTIONS);
  });

  it("without Claude Code's prompt nor instructions, on an empty file in its place", async () => {
    const args = await startWith({ claudeCodePrompt: false, instructions: '' });

    expect(args).toContain('--system-prompt-file');
    expect(fs.readFileSync(promptFile(), 'utf-8')).toBe('');
  });
});
