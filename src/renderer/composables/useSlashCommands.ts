/**
 * Slash command dispatch.
 *
 * Commands the GUI answers itself are intercepted here, before the prompt is
 * sent anywhere. That is a deliberate move from the main process, where these
 * used to live: the answers are made of renderer state — usage totals, context
 * occupation, the selected model, which panels exist — so answering them in the
 * main process meant replying "not available in GUI mode" to questions the GUI
 * could answer perfectly well.
 *
 * Anything this does not claim is passed through to the CLI untouched, which is
 * the default for every command not named in GUI_DISPOSITIONS. A command the
 * CLI gains later therefore works here without a change.
 */

import { storeToRefs } from 'pinia';
import type { Ref } from 'vue';

import {
  dispositionFor,
  findCommand,
  parseSlashInput,
  type CommandNavigationTarget,
  type GuiCommandAction,
} from '@shared/slash-commands';
import type { AboutInfo, SlashCommandInfo } from '@shared/types';

import { useChatStore } from '../stores/chat';
import { useConversationsStore } from '../stores/conversations';
import { useFilesStore } from '../stores/files';
import { useSettingsStore } from '../stores/settings';
import { useUiStore, type SettingsSection } from '../stores/ui';
import { logger } from '../utils/logger';
import { formatModelId } from '../utils/model';

/** CLAUDE.md locations, in the order the CLI itself reads them. */
const PROJECT_MEMORY_FILE = 'CLAUDE.md';

/** Which settings section each navigation target wants. */
const NAVIGATION_SECTIONS: Record<CommandNavigationTarget, SettingsSection | null> = {
  settings: null,
  'settings-auth': 'auth',
  'settings-mcp': 'mcp',
  about: null,
};

/** Render a byte/token count with thousands separators. */
function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** Render a USD amount at a precision that does not hide small costs. */
export function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** Render a duration in a form that stays readable from ms to hours. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Markdown for the command list.
 *
 * Exported and pure so the grouping can be asserted without mounting anything.
 * Claude Code's own commands and the project's are separated because they come
 * from different places and a user needs to know which is which — a project
 * command can be edited, a builtin one cannot.
 */
export function renderCommandList(commands: readonly SlashCommandInfo[]): string {
  if (commands.length === 0) {
    return (
      '## Commands\n\n' +
      'No commands are available yet — the list comes from Claude Code, and it could not ' +
      'be reached. Check **Settings → Authentication**, since the CLI cannot start without ' +
      'credentials.'
    );
  }

  const describe = (cmd: SlashCommandInfo): string => {
    const hint = cmd.argumentHint ? ` \`${cmd.argumentHint}\`` : '';
    const aliases = cmd.aliases?.length
      ? ` _(also ${cmd.aliases.map((a) => `/${a}`).join(', ')})_`
      : '';
    const description = cmd.description || '_no description_';
    return `- **/${cmd.name}**${hint}${aliases} — ${description}`;
  };

  const builtin = commands.filter((c) => c.builtin);
  const custom = commands.filter((c) => !c.builtin);
  const sections: string[] = ['## Commands\n'];

  if (builtin.length > 0) {
    sections.push('### Claude Code\n', ...builtin.map(describe), '');
  }
  if (custom.length > 0) {
    sections.push(
      '### This project and your plugins\n',
      ...custom.map(describe),
      '',
    );
  }

  sections.push(
    '_Type `/` in the prompt to search these by name or description._',
  );

  return sections.join('\n');
}

/**
 * @param commands - the live command list, owned by useClaudeChat.
 *
 * Injected rather than imported to keep this module free of a cycle back into
 * useClaudeChat, which calls this one. It also lets the dispatch be tested
 * against a fixed list instead of whatever the SDK happens to report.
 */
export function useSlashCommands(commands: Ref<SlashCommandInfo[]>) {
  const chatStore = useChatStore();
  const conversationsStore = useConversationsStore();
  const filesStore = useFilesStore();
  const settingsStore = useSettingsStore();
  const uiStore = useUiStore();

  const { sessionUsage, activeModel, totalTokensUsed, contextWindowSize, contextUsagePercent } =
    storeToRefs(chatStore);

  /** Put a finished answer in the transcript, as the assistant would. */
  function reply(markdown: string): void {
    chatStore.addAssistantMessage(markdown);
  }

  function renderUsage(): string {
    const usage = sessionUsage.value;
    if (!usage) {
      return (
        '## Usage\n\n' +
        'Nothing recorded for this conversation yet — totals arrive with the first ' +
        'completed turn.'
      );
    }

    const { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens } = usage.usage;
    const lines = [
      '## Usage\n',
      `- **Cost:** ${formatUsd(usage.totalCostUSD)}`,
      `- **Turns:** ${formatCount(usage.numTurns)}`,
      `- **Last turn took:** ${formatDuration(usage.durationMs)}`,
      '',
      '### Tokens\n',
      `| | tokens |`,
      `| --- | ---: |`,
      `| Input | ${formatCount(inputTokens)} |`,
      `| Output | ${formatCount(outputTokens)} |`,
      `| Cache read | ${formatCount(cacheReadInputTokens)} |`,
      `| Cache write | ${formatCount(cacheCreationInputTokens)} |`,
    ];

    const models = Object.entries(usage.modelUsage);
    if (models.length > 1) {
      lines.push('', '### By model\n', '| model | cost | in | out |', '| --- | ---: | ---: | ---: |');
      for (const [modelId, info] of models) {
        lines.push(
          `| ${formatModelId(modelId)} | ${formatUsd(info.costUSD)} | ` +
            `${formatCount(info.inputTokens)} | ${formatCount(info.outputTokens)} |`,
        );
      }
    }

    return lines.join('\n');
  }

  function renderContext(): string {
    const max = contextWindowSize.value;
    if (!max) {
      return (
        '## Context\n\n' +
        'The context window is not known yet — it is reported with the first completed turn.'
      );
    }

    const used = totalTokensUsed.value;
    const percent = contextUsagePercent.value;
    const remaining = Math.max(max - used, 0);

    return [
      '## Context\n',
      `- **In use:** ${formatCount(used)} of ${formatCount(max)} tokens (${percent}%)`,
      `- **Remaining:** ${formatCount(remaining)} tokens`,
      '',
      'Running low? `/compact` summarises the conversation so far and frees most of it.',
    ].join('\n');
  }

  function renderStatus(): string {
    const conversationId = chatStore.currentConversationId;
    const model = activeModel.value || settingsStore.selectedModel;
    const sdkSessionId = conversationId ? conversationsStore.getSdkSessionId(conversationId) : null;
    const cwd = conversationId
      ? conversationsStore.getConversationWorkingDirectory(conversationId) || filesStore.workingDirectory
      : filesStore.workingDirectory;

    return [
      '## Status\n',
      `- **Model:** ${model ? formatModelId(model) : '_default_'}`,
      `- **Reasoning effort:** ${settingsStore.effortLevel ?? '_default_'}`,
      `- **Working directory:** \`${cwd || '_none_'}\``,
      `- **Claude Code session:** ${sdkSessionId ? `\`${sdkSessionId}\`` : '_not started yet_'}`,
      `- **Turns this conversation:** ${formatCount(sessionUsage.value?.numTurns ?? 0)}`,
    ].join('\n');
  }

  function renderDoctor(info: AboutInfo): string {
    const row = (label: string, value: string | null): string =>
      `- **${label}:** ${value ? `\`${value}\`` : '_not found_'}`;

    return [
      '## Diagnostics\n',
      '### Versions\n',
      row('Philibert', info.appVersion),
      row('Claude Code', info.claudeCodeVersion),
      row('Agent SDK', info.agentSdkVersion),
      row('Electron', info.electronVersion),
      row('Node', info.nodeVersion),
      '',
      '### Dictation\n',
      row('whisper', info.whisperVersion),
      row('binary', info.whisperBinaryPath),
      info.whisperVersion
        ? ''
        : '\n_No whisper binary in this build, so dictation is unavailable._\n',
      '### Paths\n',
      row('App data', info.userDataPath),
      row('Log file', info.logPath),
      '',
      `Platform: \`${info.platform}/${info.arch}\`` +
        (info.bundleType ? ` (${info.bundleType} installer)` : ''),
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  function renderBug(info: AboutInfo): string {
    const lines = ['## Report a problem\n'];

    if (info.repositoryUrl) {
      lines.push(`Open an issue at ${info.repositoryUrl}/-/issues.\n`);
    } else {
      lines.push('This build has no repository URL in its manifest.\n');
    }

    lines.push(
      'Worth attaching:',
      '',
      `- the log file at \`${info.logPath}\``,
      `- the version line: Philibert ${info.appVersion}, Claude Code ${info.claudeCodeVersion ?? 'unknown'}, ${info.platform}/${info.arch}`,
      '',
      '`/doctor` prints all of it, and **About** has a **Copy details** button.',
      '',
      '_For a problem with Claude itself rather than this app, `/bug` in the CLI reports ' +
        'to Anthropic with the conversation attached._',
    );

    return lines.join('\n');
  }

  async function handleMemory(): Promise<void> {
    const cwd = filesStore.workingDirectory;
    if (!cwd) {
      reply(
        '## Memory\n\nNo working directory is open, so there is no project `CLAUDE.md` to show.',
      );
      return;
    }

    const separator = cwd.includes('\\') ? '\\' : '/';
    const projectMemory = `${cwd}${separator}${PROJECT_MEMORY_FILE}`;
    const contents = await filesStore.readFile(projectMemory);

    if (contents === null) {
      reply(
        [
          '## Memory\n',
          `This project has no \`${PROJECT_MEMORY_FILE}\` yet.`,
          '',
          `Create one at \`${projectMemory}\` and Claude Code reads it at the start of every ` +
            'conversation here. Your personal instructions live in `~/.claude/CLAUDE.md` and ' +
            'apply to every project.',
        ].join('\n'),
      );
      return;
    }

    uiStore.openMarkdownViewer(projectMemory);
    reply(`## Memory\n\nOpening \`${PROJECT_MEMORY_FILE}\` in the viewer.`);
  }

  async function handleModel(args: string): Promise<void> {
    const models = await window.electron.claude.getModels();
    const current = activeModel.value || settingsStore.selectedModel;

    if (!args) {
      const lines = [
        '## Model\n',
        `Using **${current ? formatModelId(current) : 'the default'}**.`,
        '',
        'Available:',
        '',
        ...models.map((m) => `- \`${m.value}\`${m.value === current ? ' ← current' : ''}`),
        '',
        'Switch with `/model <name>`, or use the picker in the header — which also sets ' +
          'reasoning effort.',
      ];
      reply(lines.join('\n'));
      return;
    }

    const requested = args.trim();
    const match =
      models.find((m) => m.value.toLowerCase() === requested.toLowerCase()) ??
      models.find((m) => m.value.toLowerCase().includes(requested.toLowerCase()));

    if (!match) {
      reply(
        [
          '## Model\n',
          `No model matches **${requested}**.`,
          '',
          'Available:',
          '',
          ...models.map((m) => `- \`${m.value}\``),
        ].join('\n'),
      );
      return;
    }

    await settingsStore.setSelectedModel(match.value);
    reply(
      `## Model\n\nSwitched to **${formatModelId(match.value)}**. ` +
        'It applies from your next message; this conversation keeps its context.',
    );
  }

  /**
   * Run a GUI-handled command.
   *
   * Returns nothing: every branch answers in the transcript, because a command
   * that silently does something is indistinguishable from one that is broken.
   */
  async function runGuiAction(action: GuiCommandAction, args: string): Promise<void> {
    switch (action) {
      case 'help':
        reply(renderCommandList(commands.value));
        return;

      case 'clear':
        chatStore.clearMessages();
        return;

      case 'usage':
        reply(renderUsage());
        return;

      case 'context':
        reply(renderContext());
        return;

      case 'status':
        reply(renderStatus());
        return;

      case 'doctor':
      case 'bug': {
        const info = await window.electron.about.getInfo();
        reply(action === 'doctor' ? renderDoctor(info) : renderBug(info));
        return;
      }

      case 'memory':
        await handleMemory();
        return;

      case 'model':
        await handleModel(args);
        return;

      case 'rewind':
        uiStore.openRewind();
        return;
    }
  }


  /**
   * Handle a prompt if it is a command this GUI claims.
   *
   * Returns true when the prompt was handled and must not be sent on, false
   * when it should go to the CLI as usual.
   */
  async function handleSlashCommand(content: string): Promise<boolean> {
    const parsed = parseSlashInput(content);
    if (!parsed) return false;

    const command = findCommand(commands.value, parsed.name);
    if (!command) {
      // Unknown to the SDK too. Let the CLI answer — it knows what it supports
      // and says so better than a guess here would.
      return false;
    }

    const disposition = dispositionFor(command);
    logger.info('Slash command dispatch', {
      typed: parsed.name,
      resolved: command.name,
      kind: disposition.kind,
    });

    switch (disposition.kind) {
      case 'sdk':
        return false;

      case 'gui':
        await runGuiAction(disposition.action, parsed.args);
        return true;

      case 'navigate': {
        const section = NAVIGATION_SECTIONS[disposition.target];
        if (disposition.target === 'about') {
          uiStore.openAbout();
        } else {
          uiStore.openSettings(section);
        }
        reply(disposition.message);
        return true;
      }

      case 'unavailable':
        reply(disposition.message);
        return true;
    }
  }

  return { handleSlashCommand, renderCommandList };
}
