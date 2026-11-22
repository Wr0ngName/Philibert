/**
 * MCP store — the tools Claude can use, at the two levels Claude Code has:
 *
 *  - every project: the claude.ai connectors and the user-wide servers,
 *    each on, or off everywhere (Settings → Tools);
 *  - one project: its own servers (`.mcp.json`), and the tools every project
 *    has, each of which it can turn off for itself (Settings → Project) —
 *    but not back on when it is off everywhere: that wins.
 *
 * All file work happens in the main process (McpConfigService, mcp-global-off,
 * Claude Code's own commands); this store holds what came back and the last
 * error, so the panels can stay declarative. Every change resolves with the
 * refreshed state, so there is never a separate reload that could show stale
 * state.
 */

import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';

import type {
  GlobalTools,
  McpCommandCheck,
  McpRuntimeInfo,
  McpServerEntry,
  McpServerInput,
  ProjectFolders,
  ProjectTools,
} from '@shared/types';

import { logger } from '../utils/logger';

import { useConversationsStore } from './conversations';
import { useSettingsStore } from './settings';

/** Which servers a list or form is about: the project's own, or the user-wide ones. */
export type McpScope = 'project' | 'user';

/**
 * A main-process error as the user should read it: its message is written
 * for them, but Electron prefixes it with "Error invoking remote method …".
 */
function userMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:\w*Error):\s*/, '');
}

export const useMcpStore = defineStore('mcp', () => {
  const settingsStore = useSettingsStore();

  // ============================================
  // The project being set up
  // ============================================

  /** The folders of the discussions, as last read (loadProjects). */
  const folders = ref<ProjectFolders>({ active: [], archived: [] });

  /** Read the folders of the discussions; on failure the list keeps what it had. */
  async function loadProjects(): Promise<void> {
    try {
      folders.value = await window.electron.conversation.projectFolders(settingsStore.config.autoArchiveDays);
    } catch (err) {
      logger.error('Reading the folders of the discussions failed', err);
    }
  }

  /**
   * Whether the working folder is a project Settings lists: it has a
   * discussion not archived — a new one open counts before it is first saved
   * — or none at all, a folder being set up. Not one whose discussions are all
   * archived, as when an archived one was opened: it is the open one's folder,
   * with nothing to set up for until a discussion is brought back.
   */
  const currentProjectListed = computed(() => {
    const dir = settingsStore.workingDirectory;
    if (!dir) return false;
    if (folders.value.active.includes(dir)) return true;
    // One open and not saved yet is a new discussion, started in the working
    // folder: not on disk, so the main process cannot count it.
    const conversations = useConversationsStore();
    if (conversations.currentConversationId && !conversations.currentConversation) return true;
    return !folders.value.archived.includes(dir);
  });

  /**
   * The projects Settings lists: the working folder first when it is one
   * (currentProjectListed), then the folders of the discussions not
   * archived, the most recently active first — each once.
   */
  const projectChoices = computed(() => {
    const choices = [currentProjectListed.value ? settingsStore.workingDirectory : null, ...folders.value.active];
    return [...new Set(choices.filter((dir): dir is string => !!dir))];
  });

  /**
   * The project Settings → Project is about: the one picked there while it is
   * listed, or else the first listed — the working folder when it is one.
   */
  const pickedProject = ref<string | null>(null);
  const projectDir = computed(() => {
    const picked = pickedProject.value;
    if (picked && projectChoices.value.includes(picked)) return picked;
    return projectChoices.value[0] ?? null;
  });
  const hasProject = computed(() => !!projectDir.value);

  /** Set up another listed project; null goes back to the first listed. */
  function pickProject(dir: string | null): void {
    pickedProject.value = dir;
  }

  // Read again whenever they may have changed: another working folder, a
  // discussion archived, brought back or deleted (the archived count follows
  // each), a new one first saved (the open one is held from then on), another
  // archiving delay.
  watch(
    [
      () => settingsStore.workingDirectory,
      () => useConversationsStore().archivedCount,
      () => useConversationsStore().currentConversation?.id,
      () => settingsStore.config.autoArchiveDays,
    ],
    () => void loadProjects(),
    { immediate: true },
  );

  function requireProject(): string {
    if (!projectDir.value) throw new Error('Choose a project folder first.');
    return projectDir.value;
  }

  // ============================================
  // Server lists and the form they share
  // ============================================

  // Each list — the project's servers, the user-wide ones — and what is going on with it.
  const projectServers = ref<McpServerEntry[]>([]);
  const projectLoading = ref(false);
  const projectSaving = ref(false);
  const projectError = ref<string | null>(null);
  const userServers = ref<McpServerEntry[]>([]);
  const userSaving = ref(false);
  const userError = ref<string | null>(null);
  const lists = {
    project: { servers: projectServers, isSaving: projectSaving, error: projectError },
    user: { servers: userServers, isSaving: userSaving, error: userError },
  };

  const runtimeInfo = ref<McpRuntimeInfo | null>(null);

  /**
   * Run a change to a server list against the main process, funnelling
   * failures into that list's `error` so callers stay free of try/catch.
   *
   * @returns true when it succeeded.
   */
  async function run(scope: McpScope, label: string, operation: () => Promise<McpServerEntry[]>): Promise<boolean> {
    const list = lists[scope];
    list.isSaving.value = true;
    list.error.value = null;
    try {
      list.servers.value = await operation();
      return true;
    } catch (err) {
      list.error.value = userMessage(err);
      logger.error(`MCP ${scope} ${label} failed`, err);
      return false;
    } finally {
      list.isSaving.value = false;
    }
  }

  async function loadRuntimeInfo(): Promise<void> {
    if (runtimeInfo.value) return;
    try {
      runtimeInfo.value = await window.electron.mcp.getRuntimeInfo();
    } catch (err) {
      logger.error('MCP runtime info failed', err);
    }
  }

  /** Read the project's own servers. */
  async function loadProject(): Promise<void> {
    void loadRuntimeInfo();
    if (!projectDir.value) {
      projectServers.value = [];
      return;
    }
    projectLoading.value = true;
    projectError.value = null;
    try {
      projectServers.value = await window.electron.mcp.list(projectDir.value);
    } catch (err) {
      projectError.value = userMessage(err);
      logger.error('MCP project load failed', err);
    } finally {
      projectLoading.value = false;
    }
  }

  /** Create a server, or update `previousName` when editing. */
  function save(scope: McpScope, previousName: string | null, server: McpServerInput): Promise<boolean> {
    return scope === 'project'
      ? run(scope, 'save', () => window.electron.mcp.save(requireProject(), previousName, server))
      : run(scope, 'save', async () => {
        const servers = await window.electron.mcp.saveUserServer(previousName, server);
        void checkGlobalTools();
        return servers;
      });
  }

  function remove(scope: McpScope, name: string): Promise<boolean> {
    return scope === 'project'
      ? run(scope, 'remove', () => window.electron.mcp.remove(requireProject(), name))
      : run(scope, 'remove', async () => {
        const servers = await window.electron.mcp.removeUserServer(name);
        void checkGlobalTools();
        return servers;
      });
  }

  /** A project server on or off (its approval); a user-wide one on or off everywhere. */
  async function setEnabled(scope: McpScope, name: string, enabled: boolean): Promise<boolean> {
    if (scope === 'project') {
      return run(scope, 'setEnabled', () => window.electron.mcp.setEnabled(requireProject(), name, enabled));
    }
    await setOffEverywhere(name, !enabled);
    return globalError.value === null;
  }

  function clearError(scope: McpScope): void {
    lists[scope].error.value = null;
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

  // ============================================
  // The tools every project has
  // ============================================

  /** As they stand; null before the first check. */
  const globalTools = ref<GlobalTools | null>(null);
  const isCheckingGlobal = ref(false);
  /** The tool an action is running for, on either page. */
  const toolBusy = ref<string | null>(null);
  /**
   * Connectors whose claude.ai page was opened. Says what is left to do for
   * as long as one still needs authorising.
   */
  const connectorsAuthorising = ref<string[]>([]);
  const globalError = ref<string | null>(null);

  function takeGlobalTools(tools: GlobalTools): void {
    globalTools.value = tools;
    userServers.value = tools.userServers;
  }

  /**
   * Ask how they stand. It starts a Claude Code session that runs nothing,
   * which takes a few seconds; open conversations are brought up to date
   * with any connector authorised since they started.
   */
  async function checkGlobalTools(): Promise<void> {
    void loadRuntimeInfo();
    isCheckingGlobal.value = true;
    globalError.value = null;
    try {
      takeGlobalTools(await window.electron.mcp.globalTools());
    } catch (err) {
      globalError.value = userMessage(err);
      logger.error('Checking the tools every project has failed', err);
    } finally {
      isCheckingGlobal.value = false;
    }
  }

  /** Turn one off everywhere, or back on. */
  async function setOffEverywhere(name: string, off: boolean): Promise<void> {
    toolBusy.value = name;
    globalError.value = null;
    try {
      takeGlobalTools(await window.electron.mcp.setOffEverywhere(name, off));
    } catch (err) {
      globalError.value = userMessage(err);
      logger.error('Turning a tool off everywhere failed', err);
    } finally {
      toolBusy.value = null;
    }
  }

  /** Open the claude.ai page that authorises a connector. */
  async function authorizeConnector(name: string): Promise<void> {
    toolBusy.value = name;
    globalError.value = null;
    try {
      await window.electron.mcp.authorizeConnector(name);
      if (!connectorsAuthorising.value.includes(name)) connectorsAuthorising.value.push(name);
    } catch (err) {
      globalError.value = userMessage(err);
      logger.error('Authorising a claude.ai connector failed', err);
    } finally {
      toolBusy.value = null;
    }
  }

  // ============================================
  // …as the project being set up has them
  // ============================================

  /** As the project has them; null before the first check. */
  const projectTools = ref<ProjectTools | null>(null);
  const isCheckingProject = ref(false);
  const projectToolsError = ref<string | null>(null);

  /** Ask how the project has them; starts a Claude Code session in it, as above. */
  async function checkProjectTools(): Promise<void> {
    if (!projectDir.value) {
      projectTools.value = null;
      return;
    }
    isCheckingProject.value = true;
    projectToolsError.value = null;
    try {
      projectTools.value = await window.electron.mcp.projectTools(projectDir.value);
    } catch (err) {
      projectToolsError.value = userMessage(err);
      logger.error("Checking the project's tools failed", err);
    } finally {
      isCheckingProject.value = false;
    }
  }

  /** Turn one on or off in the project. */
  async function setEnabledInProject(name: string, enabled: boolean): Promise<void> {
    toolBusy.value = name;
    projectToolsError.value = null;
    try {
      projectTools.value = await window.electron.mcp.setEnabledInProject(requireProject(), name, enabled);
    } catch (err) {
      projectToolsError.value = userMessage(err);
      logger.error('Turning a tool on or off in a project failed', err);
    } finally {
      toolBusy.value = null;
    }
  }

  // Another project, another state: what was read is not this one's.
  watch(projectDir, () => {
    projectTools.value = null;
  });

  return {
    projectDir,
    hasProject,
    projectChoices,
    currentProjectListed,
    loadProjects,
    pickProject,
    projectServers,
    projectLoading,
    projectSaving,
    projectError,
    userServers,
    userSaving,
    userError,
    runtimeInfo,
    loadProject,
    save,
    remove,
    setEnabled,
    clearError,
    checkCommand,
    pickExecutable,
    pickFile,
    globalTools,
    isCheckingGlobal,
    toolBusy,
    connectorsAuthorising,
    globalError,
    checkGlobalTools,
    setOffEverywhere,
    authorizeConnector,
    projectTools,
    isCheckingProject,
    projectToolsError,
    checkProjectTools,
    setEnabledInProject,
  };
});
