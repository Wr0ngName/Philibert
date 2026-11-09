/**
 * Comprehensive tests for the files store.
 *
 * Tests cover:
 * - Initial state
 * - Computed getters (hasFiles, workingDirectory, hasWorkingDirectory)
 * - Directory selection and file tree loading
 * - File reading
 * - Directory expansion/collapse
 * - Incremental file tree updates from file changes
 * - File watcher setup and cleanup
 */

import { setActivePinia, createPinia } from 'pinia';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { DEFAULT_CONFIG } from '../../../shared/types';
import { useFilesStore } from '../files';
import { useSettingsStore } from '../settings';

/**
 * The folders the main process reads from: each directory's entries, by path.
 * A test changes it to stand for another repository.
 */
let fakeFs: Record<string, Array<{ name: string; type: 'file' | 'directory' }>> = {};

/** What listDirectory answers: one directory's entries, as the main process lists them. */
function listOf(dir: string) {
  return (fakeFs[dir] ?? []).map((entry) => ({ ...entry, path: `${dir}/${entry.name}` }));
}

// Mock window.electron
const mockElectron = {
  files: {
    selectDirectory: vi.fn(),
    listDirectory: vi.fn(),
    read: vi.fn(),
    onChange: vi.fn(),
  },
  config: {
    get: vi.fn(),
    set: vi.fn(),
    onChange: vi.fn(),
  },
};

// Store the file change callback
let fileChangeCallback: ((changes: any[]) => void) | null = null;

describe('useFilesStore', () => {
  beforeEach(() => {
    // Set up pinia
    setActivePinia(createPinia());

    // Reset mocks
    vi.clearAllMocks();
    fileChangeCallback = null;

    // Set up window.electron mock
    (window as any).electron = mockElectron;

    // Default mock implementations
    mockElectron.config.get.mockResolvedValue({ ...DEFAULT_CONFIG, workingDirectory: '' });
    mockElectron.config.set.mockResolvedValue(undefined);
    mockElectron.config.onChange.mockReturnValue(() => {});

    mockElectron.files.selectDirectory.mockResolvedValue('/home/user/project');
    fakeFs = {
      '/home/user/project': [{ name: 'src', type: 'directory' }, { name: 'package.json', type: 'file' }],
      '/home/user/project/src': [{ name: 'lib', type: 'directory' }, { name: 'index.ts', type: 'file' }],
      '/home/user/project/src/lib': [{ name: 'util.ts', type: 'file' }],
    };
    mockElectron.files.listDirectory.mockImplementation(async (dir: string) => listOf(dir));
    mockElectron.files.read.mockResolvedValue('file content');
    mockElectron.files.onChange.mockImplementation((callback) => {
      fileChangeCallback = callback;
      return () => {
        fileChangeCallback = null;
      };
    });

    // Mock matchMedia
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Initial State
  // ===========================================================================
  describe('initial state', () => {
    it('should have empty file tree', () => {
      const store = useFilesStore();
      expect(store.fileTree).toEqual([]);
    });

    it('should have no selected file', () => {
      const store = useFilesStore();
      expect(store.selectedFile).toBeNull();
    });

    it('should have empty expanded dirs', () => {
      const store = useFilesStore();
      expect(store.expandedDirs.size).toBe(0);
    });

    it('should not be loading', () => {
      const store = useFilesStore();
      expect(store.isLoading).toBe(false);
    });

    it('should have no error', () => {
      const store = useFilesStore();
      expect(store.error).toBeNull();
    });
  });

  // ===========================================================================
  // Computed Getters
  // ===========================================================================
  describe('computed getters', () => {
    it('hasFiles should be false when empty', () => {
      const store = useFilesStore();
      expect(store.hasFiles).toBe(false);
    });

    it('hasFiles should be true when files exist', async () => {
      // Set up settings store with working directory
      const settingsStore = useSettingsStore();
      await settingsStore.loadConfig();
      settingsStore.config.workingDirectory = '/home/user/project';

      const store = useFilesStore();
      await store.loadFileTree();

      expect(store.hasFiles).toBe(true);
    });

    it('hasWorkingDirectory should be false when no directory', () => {
      const store = useFilesStore();
      expect(store.hasWorkingDirectory).toBe(false);
    });

    it('hasWorkingDirectory should be true when directory set', async () => {
      mockElectron.config.get.mockResolvedValue({
        ...DEFAULT_CONFIG,
        workingDirectory: '/home/user/project',
      });

      const settingsStore = useSettingsStore();
      await settingsStore.loadConfig();

      const store = useFilesStore();
      expect(store.hasWorkingDirectory).toBe(true);
    });
  });

  // ===========================================================================
  // selectDirectory
  // ===========================================================================
  describe('selectDirectory', () => {
    it('should call electron selectDirectory', async () => {
      const settingsStore = useSettingsStore();
      await settingsStore.loadConfig();

      const store = useFilesStore();
      await store.selectDirectory();

      expect(mockElectron.files.selectDirectory).toHaveBeenCalled();
    });

    it('should return selected directory', async () => {
      const settingsStore = useSettingsStore();
      await settingsStore.loadConfig();

      const store = useFilesStore();
      const result = await store.selectDirectory();

      expect(result).toBe('/home/user/project');
    });

    it('should update settings store working directory', async () => {
      const settingsStore = useSettingsStore();
      await settingsStore.loadConfig();

      const store = useFilesStore();
      await store.selectDirectory();

      expect(mockElectron.config.set).toHaveBeenCalledWith({ workingDirectory: '/home/user/project' });
    });

    it('should load file tree after selection', async () => {
      const settingsStore = useSettingsStore();
      await settingsStore.loadConfig();
      settingsStore.config.workingDirectory = '/home/user/project';

      const store = useFilesStore();
      await store.selectDirectory();

      expect(mockElectron.files.listDirectory).toHaveBeenCalledWith('/home/user/project', '/home/user/project');
    });

    it('should return null when selection is cancelled', async () => {
      mockElectron.files.selectDirectory.mockResolvedValue(null);

      const settingsStore = useSettingsStore();
      await settingsStore.loadConfig();

      const store = useFilesStore();
      const result = await store.selectDirectory();

      expect(result).toBeNull();
    });

    it('should set error on failure', async () => {
      mockElectron.files.selectDirectory.mockRejectedValue(new Error('Dialog error'));

      const settingsStore = useSettingsStore();
      await settingsStore.loadConfig();

      const store = useFilesStore();
      await store.selectDirectory();

      expect(store.error).toBe('Failed to select directory');
    });
  });

  // ===========================================================================
  // loadFileTree
  // ===========================================================================
  describe('loadFileTree', () => {
    beforeEach(async () => {
      mockElectron.config.get.mockResolvedValue({
        ...DEFAULT_CONFIG,
        workingDirectory: '/home/user/project',
      });
      const settingsStore = useSettingsStore();
      await settingsStore.loadConfig();
    });

    it('should not load when no working directory', async () => {
      mockElectron.config.get.mockResolvedValue({ ...DEFAULT_CONFIG, workingDirectory: '' });
      const settingsStore = useSettingsStore();
      await settingsStore.loadConfig();

      const store = useFilesStore();
      await store.loadFileTree();

      expect(mockElectron.files.listDirectory).not.toHaveBeenCalled();
    });

    // Reported: with tens of thousands of files, the panel took forever,
    // reading the whole tree before showing anything.
    it("reads the working directory's own entries, and nothing below them", async () => {
      const store = useFilesStore();
      await store.loadFileTree();

      expect(mockElectron.files.listDirectory).toHaveBeenCalledTimes(1);
      expect(mockElectron.files.listDirectory).toHaveBeenCalledWith('/home/user/project', '/home/user/project');
      expect(store.fileTree.map((n) => n.name)).toEqual(['src', 'package.json']);
      expect(store.fileTree[0].children).toBeUndefined();
    });

    it('should set isLoading during load', async () => {
      const store = useFilesStore();

      let isLoadingDuringLoad = false;
      mockElectron.files.listDirectory.mockImplementation(async () => {
        isLoadingDuringLoad = store.isLoading;
        return [];
      });

      await store.loadFileTree();

      expect(isLoadingDuringLoad).toBe(true);
      expect(store.isLoading).toBe(false);
    });

    it('should set error on failure', async () => {
      mockElectron.files.listDirectory.mockRejectedValue(new Error('Permission denied'));

      const store = useFilesStore();
      await store.loadFileTree();

      expect(store.error).toBe('Failed to load file tree');
    });

    it('should clear error before loading', async () => {
      const store = useFilesStore();
      store.error = 'Previous error';

      await store.loadFileTree();

      expect(store.error).toBeNull();
    });
  });

  // ===========================================================================
  // Reading a level at a time
  // ===========================================================================
  describe('reading a directory when it is opened', () => {
    const SRC = '/home/user/project/src';

    beforeEach(async () => {
      mockElectron.config.get.mockResolvedValue({ ...DEFAULT_CONFIG, workingDirectory: '/home/user/project' });
      await useSettingsStore().loadConfig();
    });

    it('reads its entries the first time it is opened, and only then', async () => {
      const store = useFilesStore();
      await store.loadFileTree();

      store.toggleDirectory(SRC);
      expect(store.isDirectoryLoading(SRC)).toBe(true);
      await vi.waitFor(() => expect(store.fileTree[0].children?.map((n) => n.name)).toEqual(['lib', 'index.ts']));
      expect(store.isDirectoryLoading(SRC)).toBe(false);

      store.toggleDirectory(SRC);
      store.toggleDirectory(SRC);
      expect(mockElectron.files.listDirectory).toHaveBeenCalledTimes(2);
    });

    it('keeps what is open, read again, when the tree is refreshed', async () => {
      const store = useFilesStore();
      await store.loadFileTree();
      store.expandDirectory(SRC);
      await vi.waitFor(() => expect(store.fileTree[0].children).toBeDefined());
      store.expandDirectory(`${SRC}/lib`);
      await vi.waitFor(() => expect(store.fileTree[0].children?.[0].children).toBeDefined());

      fakeFs[`${SRC}/lib`] = [{ name: 'util.ts', type: 'file' }, { name: 'zz.ts', type: 'file' }];
      await store.loadFileTree();

      expect(store.isDirectoryExpanded(`${SRC}/lib`)).toBe(true);
      expect(store.fileTree[0].children?.[0].children?.map((n) => n.name)).toEqual(['util.ts', 'zz.ts']);
    });
  });

  // ===========================================================================
  // Switching to another folder
  // ===========================================================================
  // Reported: switching to a discussion in another repository, the tree of
  // the one left behind — still being read — appeared mixed into it.
  describe('switching to another working directory', () => {
    const BIG = '/home/user/big';
    const SMALL = '/home/user/small';

    beforeEach(async () => {
      fakeFs[BIG] = [{ name: 'huge', type: 'directory' }];
      fakeFs[SMALL] = [{ name: 'README.md', type: 'file' }];
      mockElectron.config.get.mockResolvedValue({ ...DEFAULT_CONFIG, workingDirectory: BIG });
      await useSettingsStore().loadConfig();
    });

    it('shows the new folder, though the old one answers after it', async () => {
      const store = useFilesStore();
      const settings = useSettingsStore();
      let answerBig: (() => void) | null = null;
      mockElectron.files.listDirectory.mockImplementation((dir: string) =>
        dir === BIG
          ? new Promise((resolve) => { answerBig = () => resolve(listOf(BIG)); })
          : Promise.resolve(listOf(dir)));

      const loadingBig = store.loadFileTree();
      settings.config.workingDirectory = SMALL;
      await store.loadFileTree();
      answerBig!();
      await loadingBig;

      expect(store.fileTree.map((n) => n.path)).toEqual([`${SMALL}/README.md`]);
      expect(store.isLoading).toBe(false);
    });

    it('starts from an empty tree, nothing open and nothing selected', async () => {
      const store = useFilesStore();
      const settings = useSettingsStore();
      await store.loadFileTree();
      store.expandDirectory(`${BIG}/huge`);
      store.selectFile(`${BIG}/huge/a.ts`);

      settings.config.workingDirectory = SMALL;
      const loading = store.loadFileTree();
      expect(store.fileTree).toEqual([]);
      expect(store.expandedDirs.size).toBe(0);
      expect(store.selectedFile).toBeNull();
      await loading;

      expect(store.fileTree.map((n) => n.name)).toEqual(['README.md']);
    });

    it("drops a directory's entries read for the folder left behind", async () => {
      const store = useFilesStore();
      const settings = useSettingsStore();
      await store.loadFileTree();
      let answerHuge: (() => void) | null = null;
      mockElectron.files.listDirectory.mockImplementation((dir: string) =>
        dir === `${BIG}/huge`
          ? new Promise((resolve) => { answerHuge = () => resolve([{ name: 'x.ts', path: `${BIG}/huge/x.ts`, type: 'file' }]); })
          : Promise.resolve(listOf(dir)));
      store.expandDirectory(`${BIG}/huge`);

      settings.config.workingDirectory = SMALL;
      await store.loadFileTree();
      answerHuge!();
      await vi.waitFor(() => expect(store.isDirectoryLoading(`${BIG}/huge`)).toBe(false));

      expect(store.fileTree.map((n) => n.path)).toEqual([`${SMALL}/README.md`]);
    });
  });

  // ===========================================================================
  // readFile
  // ===========================================================================
  describe('readFile', () => {
    it('should read file content', async () => {
      const store = useFilesStore();
      const content = await store.readFile('/home/user/project/file.ts');

      expect(mockElectron.files.read).toHaveBeenCalledWith('/home/user/project/file.ts');
      expect(content).toBe('file content');
    });

    it('should return null on error', async () => {
      mockElectron.files.read.mockRejectedValue(new Error('File not found'));

      const store = useFilesStore();
      const content = await store.readFile('/home/user/project/missing.ts');

      expect(content).toBeNull();
      expect(store.error).toBe('Failed to read file');
    });
  });

  // ===========================================================================
  // File Selection
  // ===========================================================================
  describe('selectFile', () => {
    it('should set selected file', () => {
      const store = useFilesStore();
      store.selectFile('/home/user/project/file.ts');

      expect(store.selectedFile).toBe('/home/user/project/file.ts');
    });

    it('should allow clearing selection', () => {
      const store = useFilesStore();
      store.selectFile('/home/user/project/file.ts');
      store.selectFile(null);

      expect(store.selectedFile).toBeNull();
    });
  });

  // ===========================================================================
  // Directory Expansion
  // ===========================================================================
  describe('directory expansion', () => {
    it('toggleDirectory should expand collapsed directory', () => {
      const store = useFilesStore();
      store.toggleDirectory('/home/user/project/src');

      expect(store.expandedDirs.has('/home/user/project/src')).toBe(true);
    });

    it('toggleDirectory should collapse expanded directory', () => {
      const store = useFilesStore();
      store.expandDirectory('/home/user/project/src');
      store.toggleDirectory('/home/user/project/src');

      expect(store.expandedDirs.has('/home/user/project/src')).toBe(false);
    });

    it('expandDirectory should expand directory', () => {
      const store = useFilesStore();
      store.expandDirectory('/home/user/project/src');

      expect(store.isDirectoryExpanded('/home/user/project/src')).toBe(true);
    });

    it('collapseDirectory should collapse directory', () => {
      const store = useFilesStore();
      store.expandDirectory('/home/user/project/src');
      store.collapseDirectory('/home/user/project/src');

      expect(store.isDirectoryExpanded('/home/user/project/src')).toBe(false);
    });

    it('isDirectoryExpanded should return false for non-expanded', () => {
      const store = useFilesStore();
      expect(store.isDirectoryExpanded('/home/user/project/src')).toBe(false);
    });
  });

  // ===========================================================================
  // File Watcher
  // ===========================================================================
  describe('setupFileWatcher', () => {
    beforeEach(async () => {
      mockElectron.config.get.mockResolvedValue({
        ...DEFAULT_CONFIG,
        workingDirectory: '/home/user/project',
      });
      const settingsStore = useSettingsStore();
      await settingsStore.loadConfig();
    });

    it('should set up file change listener', async () => {
      const store = useFilesStore();
      await store.loadFileTree();
      store.setupFileWatcher();

      expect(mockElectron.files.onChange).toHaveBeenCalled();
    });

    it('should apply incremental changes for small change sets', async () => {
      const store = useFilesStore();
      await store.loadFileTree();
      store.setupFileWatcher();

      // Simulate file addition
      fileChangeCallback?.([
        { type: 'add', path: '/home/user/project/new-file.ts', kind: 'file' },
      ]);

      expect(store.fileTree.some((n: { name: string }) => n.name === 'new-file.ts')).toBe(true);
    });

    it('should read the tree again for large change sets', async () => {
      const store = useFilesStore();
      await store.loadFileTree();
      store.setupFileWatcher();

      mockElectron.files.listDirectory.mockClear();

      // Simulate many changes (over threshold)
      const manyChanges = Array.from({ length: 15 }, (_, i) => ({
        type: 'add' as const,
        path: `/home/user/project/file${i}.ts`,
        kind: 'file' as const,
      }));

      fileChangeCallback?.(manyChanges);

      expect(mockElectron.files.listDirectory).toHaveBeenCalledWith('/home/user/project', '/home/user/project');
    });

    it('should remove old watcher before setting up new one', () => {
      const unsubscribe = vi.fn();
      mockElectron.files.onChange.mockReturnValue(unsubscribe);

      const store = useFilesStore();
      store.setupFileWatcher();
      store.setupFileWatcher();

      expect(unsubscribe).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Incremental Updates
  // ===========================================================================
  describe('incremental file tree updates', () => {
    beforeEach(async () => {
      mockElectron.config.get.mockResolvedValue({
        ...DEFAULT_CONFIG,
        workingDirectory: '/home/user/project',
      });
      const settingsStore = useSettingsStore();
      await settingsStore.loadConfig();
    });

    it('should add new file to tree', async () => {
      const store = useFilesStore();
      await store.loadFileTree();
      store.setupFileWatcher();

      fileChangeCallback?.([{ type: 'add', path: '/home/user/project/new-file.ts', kind: 'file' }]);

      expect(store.fileTree.some((n: { name: string }) => n.name === 'new-file.ts')).toBe(true);
    });

    it('adds a new path as what the watcher says it is, not by its name', async () => {
      const store = useFilesStore();
      await store.loadFileTree();
      store.setupFileWatcher();

      fileChangeCallback?.([
        { type: 'add', path: '/home/user/project/Makefile', kind: 'file' },
        { type: 'add', path: '/home/user/project/v1.2', kind: 'directory' },
      ]);

      expect(store.fileTree.map((n) => [n.name, n.type])).toEqual([
        ['src', 'directory'], ['v1.2', 'directory'], ['Makefile', 'file'], ['package.json', 'file'],
      ]);
    });

    it('leaves a change inside a directory not read yet to its reading', async () => {
      const store = useFilesStore();
      await store.loadFileTree();
      store.setupFileWatcher();

      fileChangeCallback?.([{ type: 'add', path: '/home/user/project/src/new.ts', kind: 'file' }]);

      expect(store.fileTree[0].children).toBeUndefined();
    });

    it('adds a change inside a directory already read', async () => {
      const store = useFilesStore();
      await store.loadFileTree();
      store.expandDirectory('/home/user/project/src');
      await vi.waitFor(() => expect(store.fileTree[0].children).toBeDefined());
      store.setupFileWatcher();

      fileChangeCallback?.([{ type: 'add', path: '/home/user/project/src/new.ts', kind: 'file' }]);

      expect(store.fileTree[0].children?.map((n) => n.name)).toEqual(['lib', 'index.ts', 'new.ts']);
    });

    it('should remove file from tree', async () => {
      const store = useFilesStore();
      await store.loadFileTree();
      store.setupFileWatcher();

      fileChangeCallback?.([{ type: 'unlink', path: '/home/user/project/package.json' }]);

      expect(store.fileTree.some((n: { name: string }) => n.name === 'package.json')).toBe(false);
    });

    it('should maintain sort order after adding file', async () => {
      const store = useFilesStore();
      await store.loadFileTree();
      store.setupFileWatcher();

      // Add a file that should sort before package.json
      fileChangeCallback?.([{ type: 'add', path: '/home/user/project/a-file.ts', kind: 'file' }]);

      // Directories first, then alphabetically
      const fileNames = store.fileTree.map((n: { name: string }) => n.name);
      expect(fileNames).toEqual(['src', 'a-file.ts', 'package.json']);
    });
  });

  // ===========================================================================
  // clearError and reset
  // ===========================================================================
  describe('clearError', () => {
    it('should clear the error', () => {
      const store = useFilesStore();
      store.error = 'Some error';
      store.clearError();

      expect(store.error).toBeNull();
    });
  });

  describe('reset', () => {
    it('should reset all state', async () => {
      mockElectron.config.get.mockResolvedValue({
        ...DEFAULT_CONFIG,
        workingDirectory: '/home/user/project',
      });
      const settingsStore = useSettingsStore();
      await settingsStore.loadConfig();

      const store = useFilesStore();
      await store.loadFileTree();
      store.selectFile('/home/user/project/file.ts');
      store.expandDirectory('/home/user/project/src');
      store.error = 'Some error';

      store.reset();

      expect(store.fileTree).toEqual([]);
      expect(store.selectedFile).toBeNull();
      expect(store.expandedDirs.size).toBe(0);
      expect(store.error).toBeNull();
    });

    it('should clean up file watcher', () => {
      const unsubscribe = vi.fn();
      mockElectron.files.onChange.mockReturnValue(unsubscribe);

      const store = useFilesStore();
      store.setupFileWatcher();
      store.reset();

      expect(unsubscribe).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // cleanup
  // ===========================================================================
  describe('cleanup', () => {
    it('should clean up file change listener', () => {
      const unsubscribe = vi.fn();
      mockElectron.files.onChange.mockReturnValue(unsubscribe);

      const store = useFilesStore();
      store.setupFileWatcher();
      store.cleanup();

      expect(unsubscribe).toHaveBeenCalled();
    });
  });
});
