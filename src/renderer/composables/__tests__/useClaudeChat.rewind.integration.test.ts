/**
 * `/rewind` reaches the rewind dialog although the CLI no longer lists it.
 *
 * The CLI stopped advertising `/rewind` to SDK hosts (its own version is a
 * terminal screen), and only listed commands are dispatched, so typing it sent
 * the text to the CLI, which answered "/rewind isn't available in this
 * environment." The command lists below are what the CLI returns now: no
 * `rewind` row in either.
 *
 * As in MessageList.spinner.integration.test.ts, the bridge under
 * `window.electron` is the real preload; only Electron is mocked.
 */

import { mount } from '@vue/test-utils';
import { ipcRenderer } from 'electron';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, h } from 'vue';

type IpcHandler = (event: unknown, ...args: unknown[]) => void;
const { ipcListeners, exposed, invoke } = vi.hoisted(() => ({
  ipcListeners: new Map<string, ((event: unknown, ...args: unknown[]) => void)[]>(),
  exposed: { api: null as Record<string, unknown> | null },
  invoke: { handler: null as ((channel: string, ...args: unknown[]) => unknown) | null },
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, unknown>) => {
      exposed.api = api;
    },
  },
  ipcRenderer: {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
      structuredClone(args);
      return invoke.handler?.(channel, ...args);
    }),
    send: vi.fn(),
    on: (channel: string, handler: IpcHandler) => {
      const list = ipcListeners.get(channel) ?? [];
      list.push(handler);
      ipcListeners.set(channel, list);
    },
    removeListener: (channel: string, handler: IpcHandler) => {
      const list = ipcListeners.get(channel) ?? [];
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    },
  },
}));

import { IPC_CHANNELS, type SlashCommandInfo } from '../../../shared/types';
import { useChatStore } from '../../stores/chat';
import { useConversationsStore } from '../../stores/conversations';
import { useSettingsStore } from '../../stores/settings';
import { useUiStore } from '../../stores/ui';
import { useClaudeChat } from '../useClaudeChat';

import '../../../preload/preload';

const CONV = 'conv-rewind-1';

/** The CLI's own rows, as supportedCommands() returns them: no `rewind`. */
const CLI_COMMANDS: SlashCommandInfo[] = [
  { name: 'clear', description: 'Clear conversation history and free up context', argumentHint: '', builtin: true },
  { name: 'compact', description: 'Clear conversation history but keep a summary in context', argumentHint: '', builtin: true },
  { name: 'context', description: 'Visualize current context usage', argumentHint: '', builtin: true },
];

function emitIpc(channel: string, ...args: unknown[]) {
  for (const handler of [...(ipcListeners.get(channel) ?? [])]) {
    handler({}, ...args);
  }
}

let chat: ReturnType<typeof useClaudeChat> | null = null;
let mounted: ReturnType<typeof mount> | null = null;

function mountHost() {
  const Host = defineComponent({
    setup() {
      chat = useClaudeChat();
      return () => h('div');
    },
  });
  mounted = mount(Host);
}

/** Let the mount's getCommands() call resolve and land in the shared list. */
async function commandsLoaded() {
  await vi.waitFor(() => {
    expect(chat?.slashCommands.value.length).toBeGreaterThan(0);
  });
}

function sentToCli(): unknown[][] {
  return vi.mocked(ipcRenderer.invoke).mock.calls.filter(([channel]) => channel === IPC_CHANNELS.CLAUDE_SEND);
}

describe('/rewind when the CLI does not list it', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    ipcListeners.clear();
    vi.mocked(ipcRenderer.invoke).mockClear();
    invoke.handler = (channel) => {
      if (channel === IPC_CHANNELS.CLAUDE_GET_COMMANDS) return CLI_COMMANDS;
      if (/commands|models|list|queries|permissions/i.test(channel)) return [];
      return undefined;
    };
    if (!exposed.api) throw new Error('preload did not expose its API');
    (globalThis as unknown as { window: Record<string, unknown> }).window.electron = exposed.api;

    const settings = useSettingsStore();
    settings.config = { ...settings.config, apiKey: 'test-key', workingDirectory: '/project' };
    useConversationsStore().currentConversationId = CONV;
    useChatStore().currentConversationId = CONV;
  });

  // useClaudeChat keeps its listeners and command list at module level, with a
  // ref count; unmounting is what lets the next test start clean.
  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    chat = null;
  });

  it('offers it in the command list', async () => {
    mountHost();
    await commandsLoaded();

    expect(chat!.slashCommands.value.map((c) => c.name)).toContain('rewind');
  });

  it('opens the rewind dialog and sends nothing to the CLI', async () => {
    mountHost();
    await commandsLoaded();

    const outcome = await chat!.sendMessage('/rewind');

    expect(outcome).toBe('handled');
    expect(useUiStore().showRewind).toBe(true);
    expect(sentToCli()).toEqual([]);
  });

  it('still opens it after the SDK pushes a new command list without it', async () => {
    mountHost();
    await commandsLoaded();
    emitIpc(IPC_CHANNELS.CLAUDE_SLASH_COMMANDS, CONV, CLI_COMMANDS.slice(0, 2));

    const outcome = await chat!.sendMessage('/rewind');

    expect(outcome).toBe('handled');
    expect(useUiStore().showRewind).toBe(true);
    expect(sentToCli()).toEqual([]);
  });
});
