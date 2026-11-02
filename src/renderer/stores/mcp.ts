/**
 * MCP store - manages the tool servers declared by the active project.
 *
 * All filesystem work happens in the main process (McpConfigService); this
 * store only holds the list and the last error so the settings panel can stay
 * declarative. Every mutating call resolves with the refreshed list, so there
 * is never a separate reload round-trip that could show stale state.
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

import type { ClaudeAiConnector, McpCommandCheck, McpRuntimeInfo, McpServerEntry, McpServerInput } from '@shared/types';

import { logger } from '../utils/logger';

import { useSettingsStore } from './settings';

export const useMcpStore = defineStore('mcp', () => {
  const servers = ref<McpServerEntry[]>([]);
  const runtimeInfo = ref<McpRuntimeInfo | null>(null);
  const isLoading = ref(false);
  const isSaving = ref(false);
  const error = ref<string | null>(null);

  const hasProject = computed(() => !!useSettingsStore().workingDirectory);
  const enabledCount = computed(() => servers.value.filter((s) => s.enabled).length);
  /** Servers whose command cannot run — surfaced as a warning in the list. */
  const brokenServers = computed(() =>
    servers.value.filter((s) => s.check && !s.check.ok)
  );

  /**
   * A main-process error as the user should read it: its message is written
   * for them, but Electron prefixes it with "Error invoking remote method …".
   */
  function userMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:\w*Error):\s*/, '');
  }

  function projectDir(): string {
    const dir = useSettingsStore().workingDirectory;
    if (!dir) throw new Error('Choose a project folder before adding tool servers.');
    return dir;
  }

  /**
   * Run an operation against the main process, funnelling failures into
   * `error` so callers can stay free of try/catch.
   *
   * @returns true when the operation succeeded.
   */
  async function run(
    label: string,
    operation: () => Promise<McpServerEntry[]>
  ): Promise<boolean> {
    isSaving.value = true;
    error.value = null;
    try {
      servers.value = await operation();
      return true;
    } catch (err) {
      error.value = userMessage(err);
      logger.error(`MCP ${label} failed`, err);
      return false;
    } finally {
      isSaving.value = false;
    }
  }

  async function load(): Promise<void> {
    if (!hasProject.value) {
      servers.value = [];
      runtimeInfo.value = null;
      return;
    }

    isLoading.value = true;
    error.value = null;
    try {
      const dir = projectDir();
      const [list, info] = await Promise.all([
        window.electron.mcp.list(dir),
        window.electron.mcp.getRuntimeInfo(dir),
      ]);
      servers.value = list;
      runtimeInfo.value = info;
    } catch (err) {
      error.value = userMessage(err);
      logger.error('MCP load failed', err);
    } finally {
      isLoading.value = false;
    }
  }

  /** Create a server, or update `previousName` when editing. */
  function save(previousName: string | null, server: McpServerInput): Promise<boolean> {
    return run('save', () => window.electron.mcp.save(projectDir(), previousName, server));
  }

  function remove(name: string): Promise<boolean> {
    return run('remove', () => window.electron.mcp.remove(projectDir(), name));
  }

  function setEnabled(name: string, enabled: boolean): Promise<boolean> {
    return run('setEnabled', () => window.electron.mcp.setEnabled(projectDir(), name, enabled));
  }

  /** Live validation for the command field; never throws. */
  async function checkCommand(command: string): Promise<McpCommandCheck | null> {
    if (!command.trim()) return null;
    try {
      return await window.electron.mcp.checkCommand(command);
    } catch (err) {
      logger.error('MCP command check failed', err);
      return null;
    }
  }

  async function pickExecutable(): Promise<string | null> {
    try {
      return await window.electron.mcp.pickExecutable();
    } catch (err) {
      logger.error('MCP executable picker failed', err);
      return null;
    }
  }

  async function pickFile(): Promise<string | null> {
    try {
      return await window.electron.mcp.pickFile();
    } catch (err) {
      logger.error('MCP file picker failed', err);
      return null;
    }
  }

  function clearError(): void {
    error.value = null;
  }

  // ============================================
  // claude.ai connectors
  // ============================================

  /** The account's connectors as this project sees them; null before the first check. */
  const connectors = ref<ClaudeAiConnector[] | null>(null);
  /** Whether a session could be started to check them at all — no sign-in, no session. */
  const connectorsAvailable = ref(true);
  const isCheckingConnectors = ref(false);
  /** The connector an action is running for. */
  const connectorBusy = ref<string | null>(null);
  /**
   * Connectors whose claude.ai page was opened. Says what is left to do for
   * as long as one still needs authorising.
   */
  const connectorsAuthorising = ref<string[]>([]);
  const connectorsError = ref<string | null>(null);

  function takeConnectors(list: ClaudeAiConnector[] | null): void {
    connectorsAvailable.value = list !== null;
    connectors.value = list ?? [];
  }

  /**
   * Ask how the connectors stand. It starts a Claude Code session that runs
   * nothing, which takes a few seconds; open conversations are brought up to
   * date with any connector authorised since they started.
   */
  async function checkConnectors(): Promise<void> {
    if (!hasProject.value) {
      connectors.value = null;
      return;
    }
    isCheckingConnectors.value = true;
    connectorsError.value = null;
    try {
      takeConnectors(await window.electron.mcp.connectors(projectDir()));
    } catch (err) {
      connectorsError.value = userMessage(err);
      logger.error('Checking the claude.ai connectors failed', err);
    } finally {
      isCheckingConnectors.value = false;
    }
  }

  /** Open the claude.ai page that authorises a connector. */
  async function authorizeConnector(name: string): Promise<void> {
    connectorBusy.value = name;
    connectorsError.value = null;
    try {
      await window.electron.mcp.authorizeConnector(projectDir(), name);
      if (!connectorsAuthorising.value.includes(name)) connectorsAuthorising.value.push(name);
    } catch (err) {
      connectorsError.value = userMessage(err);
      logger.error('Authorising a claude.ai connector failed', err);
    } finally {
      connectorBusy.value = null;
    }
  }

  /** Turn a connector on or off for this project. */
  async function setConnectorEnabled(name: string, enabled: boolean): Promise<void> {
    connectorBusy.value = name;
    connectorsError.value = null;
    try {
      takeConnectors(await window.electron.mcp.setConnectorEnabled(projectDir(), name, enabled));
    } catch (err) {
      connectorsError.value = userMessage(err);
      logger.error('Turning a claude.ai connector on or off failed', err);
    } finally {
      connectorBusy.value = null;
    }
  }

  return {
    servers,
    runtimeInfo,
    isLoading,
    isSaving,
    error,
    hasProject,
    enabledCount,
    brokenServers,
    load,
    save,
    remove,
    setEnabled,
    checkCommand,
    pickExecutable,
    pickFile,
    clearError,
    connectors,
    connectorsAvailable,
    isCheckingConnectors,
    connectorBusy,
    connectorsAuthorising,
    connectorsError,
    checkConnectors,
    authorizeConnector,
    setConnectorEnabled,
  };
});
