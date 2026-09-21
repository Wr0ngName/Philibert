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

import type { McpCommandCheck, McpRuntimeInfo, McpServerEntry, McpServerInput } from '@shared/types';

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
      // Main-process errors carry a message written for the user; Electron
      // prefixes it with "Error invoking remote method ...", so strip that.
      const raw = err instanceof Error ? err.message : String(err);
      error.value = raw.replace(/^Error invoking remote method '[^']*':\s*/, '')
        .replace(/^(?:\w*Error):\s*/, '');
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
      const raw = err instanceof Error ? err.message : String(err);
      error.value = raw.replace(/^Error invoking remote method '[^']*':\s*/, '')
        .replace(/^(?:\w*Error):\s*/, '');
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
  };
});
