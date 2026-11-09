/**
 * Files store - manages file tree and file operations
 *
 * The tree is read a level at a time: the working directory's entries first,
 * then a directory's own when it is opened. Reading it whole before showing
 * anything took seconds in a repository of tens of thousands of files.
 *
 * Every read is for one working directory. Switching to a discussion in
 * another folder empties the tree and reads the new one; a read for the
 * folder left behind that answers late is dropped, rather than put on screen
 * under the new folder's name.
 */

import { defineStore } from 'pinia';
import { ref, computed, reactive } from 'vue';

import type { FileNode, FileChange } from '@shared/types';

import { useEventCleanup } from '../composables/useEventCleanup';
import { CONSTANTS } from '../constants/app';
import { logger } from '../utils/logger';

import { useChatStore } from './chat';
import { useSettingsStore } from './settings';

/** The tree's order: directories first, then files, each alphabetically. */
function compareNodes(a: FileNode, b: FileNode): number {
  if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export const useFilesStore = defineStore('files', () => {
  // State
  const fileTree = ref<FileNode[]>([]);
  const selectedFile = ref<string | null>(null);
  const expandedDirs = reactive(new Set<string>());
  /**
   * Directories whose entries are being read, by the load they belong to: a
   * read left over from an earlier load does not stop a later one reading.
   */
  const loadingDirs = reactive(new Map<string, number>());
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  /** The working directory the tree on screen belongs to. */
  let treeDirectory: string | null = null;
  /**
   * Bumped by every load of the tree, and by every switch of folder: a read
   * that answers after the next one has started is out of date.
   */
  let generation = 0;

  // Use centralized cleanup management
  const { addCleanup, cleanup } = useEventCleanup();

  // Track file watcher unsubscribe separately for re-setup
  let fileWatcherUnsubscribe: (() => void) | null = null;

  // Getters
  const hasFiles = computed(() => fileTree.value.length > 0);
  const workingDirectory = computed(() => useSettingsStore().workingDirectory);
  const hasWorkingDirectory = computed(() => !!workingDirectory.value);

  // Actions
  async function selectDirectory(): Promise<string | null> {
    try {
      const directory = await window.electron.files.selectDirectory();
      if (directory) {
        const settingsStore = useSettingsStore();
        await settingsStore.setWorkingDirectory(directory);
        await loadFileTree();
        setupFileWatcher();
      }
      return directory;
    } catch (err) {
      logger.error('Failed to select directory', err);
      error.value = 'Failed to select directory';
      return null;
    }
  }

  /** Forget the tree on screen: another folder's, or none. */
  function clearTree(): void {
    fileTree.value = [];
    expandedDirs.clear();
    loadingDirs.clear();
    selectedFile.value = null;
    error.value = null;
  }

  /** Whether a read started for `dir` under `started` still belongs on screen. */
  function isCurrent(dir: string, started: number): boolean {
    return started === generation && dir === workingDirectory.value;
  }

  /**
   * Read the tree of the working directory: its entries, and those of every
   * directory open in it. A different working directory from the one on
   * screen starts from an empty tree; the same one is refreshed in place,
   * keeping what is open.
   */
  async function loadFileTree(): Promise<void> {
    const dir = workingDirectory.value;
    if (!dir) return;

    if (dir !== treeDirectory) {
      clearTree();
      treeDirectory = dir;
    }
    const started = ++generation;
    isLoading.value = true;
    error.value = null;

    try {
      const entries = await window.electron.files.listDirectory(dir, dir);
      if (!isCurrent(dir, started)) return;
      fileTree.value = keepReadEntries(entries, fileTree.value);
      // What was open stays open, outermost first, so each one's directory
      // is there to put its entries in.
      const open = [...expandedDirs].sort((a, b) => a.length - b.length);
      for (const path of open) {
        if (!isCurrent(dir, started)) return;
        await readDirectory(path, dir, started);
      }
    } catch (err) {
      if (!isCurrent(dir, started)) return;
      logger.error('Failed to load file tree', err);
      error.value = 'Failed to load file tree';
    } finally {
      if (started === generation) isLoading.value = false;
    }
  }

  /**
   * Fresh entries, with the entries of the directories already read carried
   * over until they are read again — so a refresh does not close what is open.
   */
  function keepReadEntries(fresh: FileNode[], previous: FileNode[]): FileNode[] {
    const byPath = new Map(previous.map((node) => [node.path, node]));
    return fresh.map((node) => {
      const before = byPath.get(node.path);
      return node.type === 'directory' && before?.children ? { ...node, children: before.children } : node;
    });
  }

  /** The directory node at `path`, if the tree holds it. */
  function findDirectory(path: string, nodes: FileNode[] = fileTree.value): FileNode | null {
    for (const node of nodes) {
      if (node.type !== 'directory') continue;
      if (node.path === path) return node;
      if (node.children && (path.startsWith(`${node.path}/`) || path.startsWith(`${node.path}\\`))) {
        return findDirectory(path, node.children);
      }
    }
    return null;
  }

  /** Read one directory's entries into the tree. */
  async function readDirectory(path: string, dir: string, started: number): Promise<void> {
    if (loadingDirs.get(path) === started) return;
    loadingDirs.set(path, started);
    try {
      const entries = await window.electron.files.listDirectory(path, dir);
      if (!isCurrent(dir, started)) return;
      const node = findDirectory(path);
      if (!node) return; // gone since, or its parent was closed
      node.children = keepReadEntries(entries, node.children ?? []);
    } catch (err) {
      if (!isCurrent(dir, started)) return;
      logger.error('Failed to read directory', { path, err });
      const node = findDirectory(path);
      if (node) node.children = [];
    } finally {
      if (loadingDirs.get(path) === started) loadingDirs.delete(path);
    }
  }

  async function readFile(filePath: string): Promise<string | null> {
    try {
      return await window.electron.files.read(filePath);
    } catch (err) {
      logger.error('Failed to read file', err);
      error.value = 'Failed to read file';
      return null;
    }
  }

  async function openFile(filePath: string): Promise<void> {
    try {
      const result = await window.electron.files.open(filePath);
      if (!result.success) {
        logger.error('Failed to open file', { filePath, error: result.error });
        error.value = result.error || 'Failed to open file';
      }
    } catch (err) {
      logger.error('Failed to open file', err);
      error.value = 'Failed to open file';
    }
  }

  function selectFile(filePath: string | null): void {
    selectedFile.value = filePath;
  }

  /** Open or close a directory; opening it for the first time reads it. */
  function toggleDirectory(dirPath: string): void {
    if (expandedDirs.has(dirPath)) {
      expandedDirs.delete(dirPath);
    } else {
      expandDirectory(dirPath);
    }
  }

  function expandDirectory(dirPath: string): void {
    expandedDirs.add(dirPath);
    const dir = workingDirectory.value;
    if (dir && !findDirectory(dirPath)?.children) {
      void readDirectory(dirPath, dir, generation);
    }
  }

  function collapseDirectory(dirPath: string): void {
    expandedDirs.delete(dirPath);
  }

  function isDirectoryExpanded(dirPath: string): boolean {
    return expandedDirs.has(dirPath);
  }

  function isDirectoryLoading(dirPath: string): boolean {
    return loadingDirs.has(dirPath);
  }

  async function setWorkingDirectory(directory: string): Promise<void> {
    const settingsStore = useSettingsStore();
    await settingsStore.setWorkingDirectory(directory);
  }

  /**
   * Apply the watcher's changes to the directories already read. A change
   * inside a directory not read yet is picked up when it is opened.
   */
  function applyFileChanges(changes: FileChange[]): void {
    for (const change of changes) {
      const siblings = entriesHolding(change.path);
      if (!siblings) continue;
      const index = siblings.findIndex((node) => node.path === change.path);
      if (change.type === 'unlink') {
        if (index !== -1) siblings.splice(index, 1);
      } else if (change.type === 'add' && index === -1 && change.kind) {
        const node: FileNode = { name: baseName(change.path), path: change.path, type: change.kind };
        const at = siblings.findIndex((existing) => compareNodes(node, existing) < 0);
        siblings.splice(at === -1 ? siblings.length : at, 0, node);
      }
    }
  }

  /** The read entries of the directory holding `path`, or null if not read. */
  function entriesHolding(path: string): FileNode[] | null {
    const dir = workingDirectory.value;
    if (!dir) return null;
    const parent = parentPath(path);
    if (parent === null) return null;
    if (samePath(parent, dir)) return fileTree.value;
    if (!isWithin(parent, dir)) return null;
    return findDirectory(parent)?.children ?? null;
  }

  function setupFileWatcher(): void {
    // Clean up existing watcher
    if (fileWatcherUnsubscribe) {
      fileWatcherUnsubscribe();
      fileWatcherUnsubscribe = null;
    }

    // Set up new watcher
    fileWatcherUnsubscribe = window.electron.files.onChange((changes: FileChange[]) => {
      logger.debug('File changes detected', { changeCount: changes.length });

      // Feed the "modified in the last query" indicator. This is the only way
      // a file written by a shell command gets marked: Bash can write
      // anywhere and its targets are not derivable from the command line, so
      // rm, sed -i, a formatter or a build step are invisible to tool-input
      // tracking. The chat store decides attribution — it only counts a
      // change while a query is in flight, so edits made in the user's own
      // editor do not light up the tree.
      //
      // 'unlink' is left out: a deleted file has no tree row to mark, so
      // recording it would only grow the set with nothing to show.
      const chatStore = useChatStore();
      for (const change of changes) {
        if (change.type === 'unlink') continue;
        chatStore.trackWatcherModification(change.path);
      }

      // Many changes at once — a checkout, an install — read again what is
      // shown instead of applying them one by one.
      if (changes.length > CONSTANTS.FILES.BATCH_CHANGE_THRESHOLD) {
        void loadFileTree();
      } else {
        applyFileChanges(changes);
      }
    });
  }

  function clearError(): void {
    error.value = null;
  }

  function reset(): void {
    clearTree();
    treeDirectory = null;
    generation += 1;
    isLoading.value = false;

    if (fileWatcherUnsubscribe) {
      fileWatcherUnsubscribe();
      fileWatcherUnsubscribe = null;
    }
  }

  // Initialize with existing working directory if available
  // Also watch for settings changes in case config loads after this store initializes
  async function initialize(): Promise<void> {
    try {
      const settingsStore = useSettingsStore();
      const { watch } = await import('vue');

      // Watch for settings loading to complete AND working directory changes
      // This handles the race condition where settings load after this store initializes
      const stopSettingsWatcher = watch(
        [() => settingsStore.isLoading, () => settingsStore.workingDirectory],
        async ([loading, newDir], [wasLoading, oldDir]) => {
          try {
            // When settings finish loading and we have a working directory
            if (!loading && wasLoading && newDir) {
              logger.debug('Settings loaded, initializing files', { workingDirectory: newDir });
              await loadFileTree();
              setupFileWatcher();
            }
            // When working directory changes after initial load
            else if (!loading && newDir && newDir !== oldDir) {
              logger.debug('Working directory changed', { newDir, oldDir });
              await loadFileTree();
              setupFileWatcher();
            }
          } catch (err) {
            logger.error('Error in settings watcher callback', err);
          }
        },
        { immediate: true }
      );
      addCleanup(stopSettingsWatcher);

      // Also try to load immediately if settings are already loaded and have a directory
      if (!settingsStore.isLoading && settingsStore.workingDirectory) {
        logger.debug('Settings already loaded, initializing files immediately', {
          workingDirectory: settingsStore.workingDirectory,
        });
        await loadFileTree();
        setupFileWatcher();
      }
    } catch (err) {
      logger.error('Failed to initialize files store', err);
    }
  }

  // Cleanup function that uses useEventCleanup for the settings watcher
  // and manually cleans up the file watcher (since it can be re-setup)
  function cleanupStore(): void {
    cleanup(); // From useEventCleanup
    if (fileWatcherUnsubscribe) {
      fileWatcherUnsubscribe();
      fileWatcherUnsubscribe = null;
    }
  }

  return {
    // State
    fileTree,
    selectedFile,
    expandedDirs,
    isLoading,
    error,

    // Getters
    hasFiles,
    workingDirectory,
    hasWorkingDirectory,

    // Actions
    selectDirectory,
    loadFileTree,
    readFile,
    openFile,
    selectFile,
    toggleDirectory,
    expandDirectory,
    collapseDirectory,
    isDirectoryExpanded,
    isDirectoryLoading,
    setWorkingDirectory,
    setupFileWatcher,
    clearError,
    reset,
    initialize,
    cleanup: cleanupStore,
  };
});

/** A path's last segment, for either separator. */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** The directory holding `path`, or null for a root. */
function parentPath(path: string): string | null {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut > 0 ? path.slice(0, cut) : null;
}

function normalized(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function samePath(a: string, b: string): boolean {
  return normalized(a) === normalized(b);
}

/** Whether `path` is inside `dir` (not `dir` itself). */
function isWithin(path: string, dir: string): boolean {
  return normalized(path).startsWith(`${normalized(dir)}/`);
}
