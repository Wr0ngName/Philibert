/**
 * Slash command dispatch in the renderer.
 *
 * The contract that matters most is the boolean: true means the prompt was
 * answered here and must NOT be sent, false means it goes to the CLI. Get it
 * backwards and either a command is sent to the model as literal text, or a
 * genuine prompt is swallowed and never answered.
 *
 * The other thing asserted here is that commands do not merely print an
 * apology: /usage reports real totals, /status reports the real model and
 * directory, /model actually switches. Those are the behaviours that were
 * missing, so they are pinned.
 */

import { setActivePinia, createPinia } from 'pinia';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref } from 'vue';

import type { AboutInfo, SlashCommandInfo } from '@shared/types';

import { useChatStore } from '../../stores/chat';
import { useSettingsStore } from '../../stores/settings';
import { useUiStore } from '../../stores/ui';
import { useSlashCommands } from '../useSlashCommands';

const CONV = 'conv-commands';

function cmd(name: string, extra: Partial<SlashCommandInfo> = {}): SlashCommandInfo {
  return { name, description: `${name} description`, argumentHint: '', ...extra };
}

/** The commands the SDK would report for these tests. */
const COMMANDS: SlashCommandInfo[] = [
  cmd('help', { builtin: true }),
  cmd('clear', { builtin: true }),
  cmd('usage', { builtin: true, aliases: ['cost', 'stats'] }),
  cmd('context', { builtin: true }),
  cmd('status', { builtin: true }),
  cmd('doctor', { builtin: true }),
  cmd('bug', { builtin: true }),
  cmd('model', { builtin: true, argumentHint: '[model]' }),
  cmd('memory', { builtin: true }),
  cmd('rewind', { builtin: true }),
  cmd('agents', { builtin: true }),
  cmd('mcp', { builtin: true }),
  cmd('login', { builtin: true }),
  cmd('vim', { builtin: true }),
  cmd('compact', { builtin: true }),
  cmd('deploy', { description: 'Ship it' }),
];

const ABOUT: AboutInfo = {
  appVersion: '0.20.0-rc.2',
  agentSdkVersion: '0.3.280',
  claudeCodeVersion: '2.1.280',
  whisperVersion: 'v1.9.5',
  whisperBinaryPath: '/opt/philibert/whisper-cli',
  electronVersion: '42.0.1',
  chromeVersion: '140',
  nodeVersion: '22.0.0',
  platform: 'linux',
  arch: 'x64',
  bundleType: null,
  repositoryUrl: 'https://dev.web.wr0ng.name/wrongname/philibert',
  license: 'MIT',
  userDataPath: '/home/u/.config/Philibert',
  logPath: '/home/u/.config/Philibert/logs/main.log',
};

/** Only the boundaries: IPC and the config save behind setSelectedModel. */
function stubElectron(overrides: Record<string, unknown> = {}) {
  const api = {
    claude: {
      getModels: vi.fn(async () => [
        { value: 'claude-opus-5', displayName: 'Opus 5' },
        { value: 'claude-sonnet-5', displayName: 'Sonnet 5' },
      ]),
      getAgents: vi.fn(async () => [
        { name: 'Explore', description: 'Read-only search agent', model: 'inherit' },
        { name: 'reviewer', description: 'Code review specialist' },
      ]),
      previewRewind: vi.fn(),
      applyRewind: vi.fn(),
      ...(overrides.claude as object),
    },
    about: { getInfo: vi.fn(async () => ABOUT) },
    files: { read: vi.fn(async () => null) },
    config: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
  };
  (globalThis as unknown as { window: { electron: unknown } }).window ??= {} as never;
  (window as unknown as { electron: unknown }).electron = api;
  return api;
}

function dispatcher() {
  return useSlashCommands(ref(COMMANDS));
}

/**
 * Set the working directory the way the app does.
 *
 * filesStore.workingDirectory is a computed over the settings config, so it
 * cannot be assigned directly — writing to it silently does nothing and the
 * command under test then reports "_none_".
 */
function setWorkingDirectory(path: string): void {
  useSettingsStore().config.workingDirectory = path;
}

describe('pass-through to the CLI', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    stubElectron();
    useChatStore().setCurrentConversation(CONV);
  });

  it('does not claim ordinary prompts', async () => {
    const { handleSlashCommand } = dispatcher();
    expect(await handleSlashCommand('please refactor this')).toBe(false);
  });

  it('does not claim a command the SDK never reported', async () => {
    // The CLI knows what it supports and says so better than a guess here.
    const { handleSlashCommand } = dispatcher();
    expect(await handleSlashCommand('/not-a-command')).toBe(false);
  });

  it('does not claim a project command', async () => {
    const { handleSlashCommand } = dispatcher();
    expect(await handleSlashCommand('/deploy staging')).toBe(false);
  });

  it('does not claim /compact', async () => {
    const { handleSlashCommand } = dispatcher();
    expect(await handleSlashCommand('/compact focus on CI')).toBe(false);
  });

  it('does not claim a pasted absolute path', async () => {
    // "/usr/bin/env" must reach the model as text, not run as "/usr".
    const { handleSlashCommand } = dispatcher();
    expect(await handleSlashCommand('/usr/bin/env python runs it')).toBe(false);
  });

  it('adds nothing to the transcript when it passes a prompt through', async () => {
    const chat = useChatStore();
    const before = chat.messages.length;
    const { handleSlashCommand } = dispatcher();

    await handleSlashCommand('/deploy');

    expect(chat.messages).toHaveLength(before);
  });
});

describe('commands answered in the GUI', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    stubElectron();
    useChatStore().setCurrentConversation(CONV);
  });

  it('/help lists the real commands, grouped by origin', async () => {
    const chat = useChatStore();
    const { handleSlashCommand } = dispatcher();

    expect(await handleSlashCommand('/help')).toBe(true);

    const answer = chat.messages.at(-1)?.content ?? '';
    expect(answer).toContain('/rewind');
    expect(answer).toContain('/deploy');
    expect(answer).toContain('Claude Code');
    expect(answer).toContain('This project and your plugins');
  });

  it('/help shows aliases so the user knows they can be typed', async () => {
    const chat = useChatStore();
    const { handleSlashCommand } = dispatcher();

    await handleSlashCommand('/help');

    expect(chat.messages.at(-1)?.content).toContain('/cost');
  });

  it('/clear empties the transcript', async () => {
    const chat = useChatStore();
    chat.addUserMessage('something');
    const { handleSlashCommand } = dispatcher();

    expect(await handleSlashCommand('/clear')).toBe(true);
    expect(chat.messages).toEqual([]);
  });

  it('/usage reports the real totals', async () => {
    const chat = useChatStore();
    chat.updateSessionUsage(CONV, {
      totalCostUSD: 1.2345,
      usage: {
        inputTokens: 12345,
        outputTokens: 678,
        cacheReadInputTokens: 90,
        cacheCreationInputTokens: 12,
      },
      modelUsage: {},
      numTurns: 7,
      durationMs: 4200,
    });
    const { handleSlashCommand } = dispatcher();

    expect(await handleSlashCommand('/usage')).toBe(true);

    const answer = chat.messages.at(-1)?.content ?? '';
    expect(answer).toContain('$1.23');
    expect(answer).toContain('12,345');
    expect(answer).toContain('7');
  });

  it('/cost resolves to /usage through its alias', async () => {
    const chat = useChatStore();
    const { handleSlashCommand } = dispatcher();

    expect(await handleSlashCommand('/cost')).toBe(true);
    expect(chat.messages.at(-1)?.content).toContain('## Usage');
  });

  it('/usage says so plainly when nothing has been recorded', async () => {
    const chat = useChatStore();
    const { handleSlashCommand } = dispatcher();

    await handleSlashCommand('/usage');

    expect(chat.messages.at(-1)?.content).toContain('Nothing recorded');
  });

  it('/context reports occupation against the real window', async () => {
    const chat = useChatStore();
    chat.updateSessionUsage(CONV, {
      totalCostUSD: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      modelUsage: {},
      numTurns: 1,
      durationMs: 10,
      contextTokens: 50_000,
      contextMaxTokens: 200_000,
    });
    const { handleSlashCommand } = dispatcher();

    expect(await handleSlashCommand('/context')).toBe(true);

    const answer = chat.messages.at(-1)?.content ?? '';
    expect(answer).toContain('50,000');
    expect(answer).toContain('200,000');
    expect(answer).toContain('150,000'); // remaining
  });

  it('/status reports the working directory and model', async () => {
    const chat = useChatStore();
    setWorkingDirectory('/mnt/data/git/philibert');
    chat.setActiveModel(CONV, 'claude-opus-5');
    const { handleSlashCommand } = dispatcher();

    expect(await handleSlashCommand('/status')).toBe(true);

    const answer = chat.messages.at(-1)?.content ?? '';
    expect(answer).toContain('/mnt/data/git/philibert');
    expect(answer).toContain('Opus');
  });

  it('/doctor reports real versions and paths', async () => {
    const chat = useChatStore();
    const { handleSlashCommand } = dispatcher();

    expect(await handleSlashCommand('/doctor')).toBe(true);

    const answer = chat.messages.at(-1)?.content ?? '';
    expect(answer).toContain('2.1.280');
    expect(answer).toContain('v1.9.5');
    expect(answer).toContain('/home/u/.config/Philibert/logs/main.log');
  });

  it('/bug points at this project rather than the CLI repository', async () => {
    // It used to send people to anthropics/claude-code for Philibert bugs.
    const chat = useChatStore();
    const { handleSlashCommand } = dispatcher();

    expect(await handleSlashCommand('/bug')).toBe(true);

    const answer = chat.messages.at(-1)?.content ?? '';
    expect(answer).toContain('dev.web.wr0ng.name/wrongname/philibert');
    expect(answer).not.toContain('github.com/anthropics/claude-code/issues');
  });
});

describe('/model', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    stubElectron();
    useChatStore().setCurrentConversation(CONV);
  });

  it('lists the available models when given no argument', async () => {
    const chat = useChatStore();
    const { handleSlashCommand } = dispatcher();

    expect(await handleSlashCommand('/model')).toBe(true);
    expect(chat.messages.at(-1)?.content).toContain('claude-sonnet-5');
  });

  it('switches the model when given one', async () => {
    const settings = useSettingsStore();
    const setSelectedModel = vi.spyOn(settings, 'setSelectedModel').mockResolvedValue();
    const { handleSlashCommand } = dispatcher();

    expect(await handleSlashCommand('/model claude-sonnet-5')).toBe(true);
    expect(setSelectedModel).toHaveBeenCalledWith('claude-sonnet-5');
  });

  it('accepts a partial name', async () => {
    const settings = useSettingsStore();
    const setSelectedModel = vi.spyOn(settings, 'setSelectedModel').mockResolvedValue();
    const { handleSlashCommand } = dispatcher();

    await handleSlashCommand('/model sonnet');

    expect(setSelectedModel).toHaveBeenCalledWith('claude-sonnet-5');
  });

  it('does not switch to something that does not exist', async () => {
    const chat = useChatStore();
    const settings = useSettingsStore();
    const setSelectedModel = vi.spyOn(settings, 'setSelectedModel').mockResolvedValue();
    const { handleSlashCommand } = dispatcher();

    expect(await handleSlashCommand('/model gpt-4')).toBe(true);

    expect(setSelectedModel).not.toHaveBeenCalled();
    expect(chat.messages.at(-1)?.content).toContain('No model matches');
  });
});

describe('commands that open a GUI surface', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    stubElectron();
    useChatStore().setCurrentConversation(CONV);
  });

  it('/mcp opens settings at the tool servers section', async () => {
    const ui = useUiStore();
    const { handleSlashCommand } = dispatcher();

    expect(await handleSlashCommand('/mcp')).toBe(true);
    expect(ui.showSettings).toBe(true);
    expect(ui.pendingSettingsSection).toBe('mcp');
  });

  it('/login opens settings at the authentication section', async () => {
    const ui = useUiStore();
    const { handleSlashCommand } = dispatcher();

    await handleSlashCommand('/login');

    expect(ui.showSettings).toBe(true);
    expect(ui.pendingSettingsSection).toBe('auth');
  });

  it('/rewind opens the rewind dialog', async () => {
    const ui = useUiStore();
    const { handleSlashCommand } = dispatcher();

    expect(await handleSlashCommand('/rewind')).toBe(true);
    expect(ui.showRewind).toBe(true);
  });

  it('says in the transcript where it sent the user', async () => {
    // Opening a panel with no explanation looks like the command did nothing.
    const chat = useChatStore();
    const { handleSlashCommand } = dispatcher();

    await handleSlashCommand('/mcp');

    expect(chat.messages.at(-1)?.content).toContain('Tool Servers');
  });
});

describe('/memory', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useChatStore().setCurrentConversation(CONV);
  });

  it('opens the project CLAUDE.md in the viewer when it exists', async () => {
    stubElectron();
    (window as unknown as { electron: { files: { read: unknown } } }).electron.files.read = vi.fn(
      async () => '# Project rules',
    );
    setWorkingDirectory('/mnt/data/git/philibert');
    const ui = useUiStore();
    const { handleSlashCommand } = dispatcher();

    expect(await handleSlashCommand('/memory')).toBe(true);
    expect(ui.markdownViewerPath).toBe('/mnt/data/git/philibert/CLAUDE.md');
  });

  it('explains how to create one when the project has none', async () => {
    stubElectron();
    setWorkingDirectory('/mnt/data/git/philibert');
    const ui = useUiStore();
    const chat = useChatStore();
    const { handleSlashCommand } = dispatcher();

    expect(await handleSlashCommand('/memory')).toBe(true);

    expect(ui.markdownViewerPath).toBeNull();
    expect(chat.messages.at(-1)?.content).toContain('CLAUDE.md');
    expect(chat.messages.at(-1)?.content).toContain('~/.claude/CLAUDE.md');
  });
});

describe('/agents', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    stubElectron();
    useChatStore().setCurrentConversation(CONV);
  });

  it('lists the real agents with their models', async () => {
    // The regression this pins: /agents used to print an apology telling the
    // user to go and read .claude/agents/*.md themselves. It must report what
    // the SDK actually says is available.
    const chat = useChatStore();
    const { handleSlashCommand } = dispatcher();

    expect(await handleSlashCommand('/agents')).toBe(true);

    const answer = chat.messages.at(-1)?.content ?? '';
    expect(answer).toContain('Explore');
    expect(answer).toContain('Read-only search agent');
    expect(answer).toContain('reviewer');
    expect(answer).toContain('inherit');
  });

  it('is never an apology', async () => {
    const chat = useChatStore();
    const { handleSlashCommand } = dispatcher();

    await handleSlashCommand('/agents');

    const answer = chat.messages.at(-1)?.content ?? '';
    expect(answer).not.toMatch(/no screen|not (yet )?(available|supported)/i);
  });

  it('shows one agent in detail when named', async () => {
    const chat = useChatStore();
    const { handleSlashCommand } = dispatcher();

    expect(await handleSlashCommand('/agents reviewer')).toBe(true);

    const answer = chat.messages.at(-1)?.content ?? '';
    expect(answer).toContain('## reviewer');
    expect(answer).toContain('Code review specialist');
  });

  it('matches a name case-insensitively and partially', async () => {
    const chat = useChatStore();
    const { handleSlashCommand } = dispatcher();

    await handleSlashCommand('/agents EXPLO');

    expect(chat.messages.at(-1)?.content).toContain('## Explore');
  });

  it('opens the project definition file when the project defines the agent', async () => {
    stubElectron();
    (window as unknown as { electron: { files: { read: unknown } } }).electron.files.read = vi.fn(
      async () => '---\nname: reviewer\n---\nreview things',
    );
    setWorkingDirectory('/mnt/data/git/philibert');
    const ui = useUiStore();
    const { handleSlashCommand } = dispatcher();

    await handleSlashCommand('/agents reviewer');

    expect(ui.markdownViewerPath).toBe('/mnt/data/git/philibert/.claude/agents/reviewer.md');
  });

  it('does not claim a definition is missing for a builtin agent', async () => {
    // Claude Code's own agents have no file in the project. That is normal,
    // not an error, and the wording must not read as a fault.
    setWorkingDirectory('/mnt/data/git/philibert');
    const chat = useChatStore();
    const ui = useUiStore();
    const { handleSlashCommand } = dispatcher();

    await handleSlashCommand('/agents Explore');

    expect(ui.markdownViewerPath).toBeNull();
    expect(chat.messages.at(-1)?.content).toContain('Claude Code itself');
  });

  it('says so plainly when there is no agent by that name', async () => {
    const chat = useChatStore();
    const { handleSlashCommand } = dispatcher();

    expect(await handleSlashCommand('/agents nope')).toBe(true);
    expect(chat.messages.at(-1)?.content).toContain('No agent matches');
  });
});

describe('commands that do not apply to a GUI', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    stubElectron();
    useChatStore().setCurrentConversation(CONV);
  });

  it('/vim explains what it would have done and what to use instead', async () => {
    const chat = useChatStore();
    const { handleSlashCommand } = dispatcher();

    expect(await handleSlashCommand('/vim')).toBe(true);

    const answer = chat.messages.at(-1)?.content ?? '';
    expect(answer).toContain('prompt box');
    expect(answer).not.toMatch(/^_?not (yet )?(available|supported)/i);
  });
});
