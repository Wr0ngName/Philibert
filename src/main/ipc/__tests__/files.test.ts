/**
 * Comprehensive tests for Files IPC handlers.
 *
 * Tests cover:
 * - FILES_SELECT_DIR handler for directory selection
 * - FILES_LIST_DIRECTORY handler, one directory of the tree at a time
 * - FILES_READ handler for file content reading
 * - File change notifications
 * - Service validation for all handlers
 * - Input validation and path security
 * - Error propagation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to ensure mocks are available before vi.mock is called
const { mockIpcMainHandle, mockIpcMain, mockDialog, mockShell } = vi.hoisted(() => {
  const mockIpcMainHandle = vi.fn();
  const _mockIpcMainOn = vi.fn();
  return {
    mockShell: { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() },
    mockIpcMainHandle,
    mockIpcMain: {
      handle: mockIpcMainHandle,
      on: _mockIpcMainOn,
      removeHandler: vi.fn(),
      removeAllListeners: vi.fn(),
    },
    mockDialog: {
      showOpenDialog: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
  dialog: mockDialog,
  shell: mockShell,
  BrowserWindow: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockFileWatcher = {
  watch: vi.fn(),
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  onChange: vi.fn(),
  stop: vi.fn(),
  _changeCallback: null as ((changes: any[]) => void) | null,
};

const mockConfigService = {
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  setWorkingDirectory: vi.fn(),
  getWorkingDirectory: vi.fn(),
};

const mockMainWindow = {
  webContents: {
    send: vi.fn(),
  },
  isDestroyed: vi.fn().mockReturnValue(false),
};

const mockGetMainWindow = vi.fn(() => mockMainWindow);

// Import after mocks
import { IPC_CHANNELS } from '../../../shared/types';
import { FileSystemError } from '../../errors';
import { setupFilesIPC } from '../files';

describe('Files IPC handlers', () => {
  let handlers: Map<string, (...args: unknown[]) => unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();

    // Reset mockGetMainWindow to return the window (may have been set to null in previous test)
    mockGetMainWindow.mockReturnValue(mockMainWindow);
    // Reset isDestroyed mock (clearAllMocks doesn't reset implementations)
    mockMainWindow.isDestroyed.mockReturnValue(false);

    // Capture registered handlers
    mockIpcMainHandle.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    });

    // Default mock implementations
    mockDialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/home/user/project'],
    });

    mockFileWatcher.watch.mockReturnValue(undefined);
    mockFileWatcher.listDirectory.mockResolvedValue([
      { name: 'src', path: '/home/user/project/src', type: 'directory' },
      { name: 'package.json', path: '/home/user/project/package.json', type: 'file' },
    ]);
    mockFileWatcher.readFile.mockResolvedValue('file content');
    mockFileWatcher.onChange.mockImplementation((callback) => {
      // Store callback for later testing
      mockFileWatcher._changeCallback = callback;
    });

    mockConfigService.setWorkingDirectory.mockResolvedValue(undefined);
    mockConfigService.getWorkingDirectory.mockResolvedValue('/home/user/project');

    // Register handlers
    setupFilesIPC(
      mockFileWatcher as any,
      mockConfigService as any,
      mockGetMainWindow as any
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Handler Registration
  // ===========================================================================
  describe('handler registration', () => {
    it('should register all files handlers', () => {
      expect(handlers.has(IPC_CHANNELS.FILES_SELECT_DIR)).toBe(true);
      expect(handlers.has(IPC_CHANNELS.FILES_LIST_DIRECTORY)).toBe(true);
      expect(handlers.has(IPC_CHANNELS.FILES_READ)).toBe(true);
    });

    it('should set up file change notifications', () => {
      expect(mockFileWatcher.onChange).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // FILES_SELECT_DIR
  // ===========================================================================
  describe('FILES_SELECT_DIR handler', () => {
    let handler: (...args: unknown[]) => unknown;

    beforeEach(() => {
      handler = handlers.get(IPC_CHANNELS.FILES_SELECT_DIR)!;
    });

    it('should open directory picker and return selected path', async () => {
      const result = await handler({});

      expect(mockDialog.showOpenDialog).toHaveBeenCalledWith(mockMainWindow, {
        title: 'Select Working Directory',
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Select',
      });
      expect(result).toBe('/home/user/project');
    });

    it('should save directory to config', async () => {
      await handler({});

      expect(mockConfigService.setWorkingDirectory).toHaveBeenCalledWith('/home/user/project');
    });

    // The working directory's change retargets the watcher (index.ts). This
    // handler watched it a second time: the whole folder walked twice, the
    // window frozen twice as long (4.3 s on a 100,000-entry folder).
    it('leaves watching the new directory to the working directory change', async () => {
      await handler({});

      expect(mockConfigService.setWorkingDirectory).toHaveBeenCalledWith('/home/user/project');
      expect(mockFileWatcher.watch).not.toHaveBeenCalled();
    });

    it('should return null when dialog is cancelled', async () => {
      mockDialog.showOpenDialog.mockResolvedValue({
        canceled: true,
        filePaths: [],
      });

      const result = await handler({});

      expect(result).toBeNull();
      expect(mockConfigService.setWorkingDirectory).not.toHaveBeenCalled();
    });

    it('should return null when no paths selected', async () => {
      mockDialog.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: [],
      });

      const result = await handler({});

      expect(result).toBeNull();
    });

    it('should return null when main window is not available', async () => {
      mockGetMainWindow.mockReturnValue(null as any);

      const result = await handler({});

      expect(result).toBeNull();
      expect(mockDialog.showOpenDialog).not.toHaveBeenCalled();
    });

    it('should throw when file watcher is not initialized', async () => {
      handlers.clear();
      setupFilesIPC(null as any, mockConfigService as any, mockGetMainWindow as any);
      const nullHandler = handlers.get(IPC_CHANNELS.FILES_SELECT_DIR)!;

      // ValidationError is caught and wrapped in FileSystemError by the handler
      await expect(nullHandler({})).rejects.toThrow(FileSystemError);
    });

    it('should throw when config service is not initialized', async () => {
      handlers.clear();
      setupFilesIPC(mockFileWatcher as any, null as any, mockGetMainWindow as any);
      const nullHandler = handlers.get(IPC_CHANNELS.FILES_SELECT_DIR)!;

      // ValidationError is caught and wrapped in FileSystemError by the handler
      await expect(nullHandler({})).rejects.toThrow(FileSystemError);
    });

    it('should propagate dialog errors', async () => {
      mockDialog.showOpenDialog.mockRejectedValue(new Error('Dialog error'));

      await expect(handler({})).rejects.toThrow(FileSystemError);
    });

    it('should handle path with spaces', async () => {
      mockDialog.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ['/home/user/my project folder'],
      });

      const result = await handler({});

      expect(result).toBe('/home/user/my project folder');
      expect(mockConfigService.setWorkingDirectory).toHaveBeenCalledWith('/home/user/my project folder');
    });
  });

  // ===========================================================================
  // FILES_LIST_DIRECTORY
  // ===========================================================================
  describe('FILES_LIST_DIRECTORY handler', () => {
    const WORKDIR = '/home/user/project';
    let handler: (...args: unknown[]) => unknown;

    beforeEach(() => {
      handler = handlers.get(IPC_CHANNELS.FILES_LIST_DIRECTORY)!;
    });

    it("returns the directory's entries, one level deep", async () => {
      const result = await handler({}, `${WORKDIR}/src`, WORKDIR);

      expect(mockFileWatcher.listDirectory).toHaveBeenCalledWith(`${WORKDIR}/src`, WORKDIR);
      expect(result).toEqual([
        { name: 'src', path: '/home/user/project/src', type: 'directory' },
        { name: 'package.json', path: '/home/user/project/package.json', type: 'file' },
      ]);
    });

    it.each([
      ['not a string', 123],
      ['empty', ''],
      ['only whitespace', '   '],
      ['null', null],
    ])('refuses a directory that is %s', async (_label, directory) => {
      await expect(handler({}, directory, WORKDIR)).rejects.toThrow(FileSystemError);
    });

    it('refuses a working directory that is missing', async () => {
      await expect(handler({}, `${WORKDIR}/src`, undefined)).rejects.toThrow(FileSystemError);
    });

    it('refuses a path that climbs out', async () => {
      await expect(handler({}, '../relative/path', WORKDIR)).rejects.toThrow(FileSystemError);
      await expect(handler({}, '/home/user/../etc/passwd', WORKDIR)).rejects.toThrow(FileSystemError);
    });

    it('fails when the file watcher is not initialized', async () => {
      handlers.clear();
      setupFilesIPC(null as any, mockConfigService as any, mockGetMainWindow as any);
      const nullHandler = handlers.get(IPC_CHANNELS.FILES_LIST_DIRECTORY)!;

      // ValidationError is caught and wrapped in FileSystemError by the handler
      await expect(nullHandler({}, WORKDIR, WORKDIR)).rejects.toThrow(FileSystemError);
    });

    it("passes on the file watcher's errors", async () => {
      mockFileWatcher.listDirectory.mockRejectedValue(new Error('Permission denied'));

      await expect(handler({}, WORKDIR, WORKDIR)).rejects.toThrow(FileSystemError);
    });
  });

  // ===========================================================================
  // FILES_OPEN and FILES_SHOW_IN_FOLDER, from the file panel's menu
  // ===========================================================================
  describe('handing a path of the working directory to the system', () => {
    const open = () => handlers.get(IPC_CHANNELS.FILES_OPEN)!;
    const showInFolder = () => handlers.get(IPC_CHANNELS.FILES_SHOW_IN_FOLDER)!;

    it('opens a file, or a folder, of the working directory', async () => {
      expect(await open()({}, '/home/user/project/src')).toEqual({ success: true });
      expect(mockShell.openPath).toHaveBeenCalledWith('/home/user/project/src');
    });

    it('shows a file of the working directory in the file manager', async () => {
      expect(await showInFolder()({}, '/home/user/project/package.json')).toEqual({ success: true });
      expect(mockShell.showItemInFolder).toHaveBeenCalledWith('/home/user/project/package.json');
    });

    // The check was a plain prefix: a sibling folder whose name begins with
    // the working directory's passed it.
    it.each([
      ['a sibling folder sharing its name', '/home/user/project2/secret.txt'],
      ['another folder', '/etc/passwd'],
    ])('refuses %s', async (_label, target) => {
      expect(await open()({}, target)).toEqual({ success: false, error: 'File is outside working directory' });
      expect(await showInFolder()({}, target)).toEqual({ success: false, error: 'File is outside working directory' });
      expect(mockShell.openPath).not.toHaveBeenCalled();
      expect(mockShell.showItemInFolder).not.toHaveBeenCalled();
    });

    it('refuses everything when no working directory is set', async () => {
      mockConfigService.getWorkingDirectory.mockResolvedValue(null);

      expect(await showInFolder()({}, '/home/user/project/a.ts')).toEqual({ success: false, error: 'No working directory set' });
    });
  });

  // ===========================================================================
  // FILES_READ
  // ===========================================================================
  describe('FILES_READ handler', () => {
    let handler: (...args: unknown[]) => unknown;

    beforeEach(() => {
      handler = handlers.get(IPC_CHANNELS.FILES_READ)!;
    });

    it('should read file content', async () => {
      const result = await handler({}, '/home/user/project/file.txt');

      expect(mockFileWatcher.readFile).toHaveBeenCalledWith(
        '/home/user/project/file.txt',
        '/home/user/project'
      );
      expect(result).toBe('file content');
    });

    it('should throw when file path is not a string', async () => {
      await expect(handler({}, 123)).rejects.toThrow(FileSystemError);
    });

    it('should throw when file path is empty', async () => {
      await expect(handler({}, '')).rejects.toThrow(FileSystemError);
    });

    it('should throw when file path is null', async () => {
      await expect(handler({}, null)).rejects.toThrow(FileSystemError);
    });

    it('should throw when path is relative', async () => {
      // validatePath catches path traversal, not relative paths per se
      // But relative paths with ../  will be caught
      await expect(handler({}, '../relative/file.txt')).rejects.toThrow(FileSystemError);
    });

    it('should throw when path contains traversal', async () => {
      await expect(handler({}, '/home/user/project/../../../etc/passwd')).rejects.toThrow(FileSystemError);
    });

    it('should throw when no working directory is set', async () => {
      mockConfigService.getWorkingDirectory.mockResolvedValue(null);

      await expect(handler({}, '/home/user/project/file.txt')).rejects.toThrow(FileSystemError);
    });

    it('should throw when working directory is empty', async () => {
      mockConfigService.getWorkingDirectory.mockResolvedValue('');

      await expect(handler({}, '/home/user/project/file.txt')).rejects.toThrow(FileSystemError);
    });

    it('should throw when file watcher is not initialized', async () => {
      handlers.clear();
      setupFilesIPC(null as any, mockConfigService as any, mockGetMainWindow as any);
      const nullHandler = handlers.get(IPC_CHANNELS.FILES_READ)!;

      // ValidationError is caught and wrapped in FileSystemError by the handler
      await expect(nullHandler({}, '/home/user/file.txt')).rejects.toThrow(FileSystemError);
    });

    it('should throw when config service is not initialized', async () => {
      handlers.clear();
      setupFilesIPC(mockFileWatcher as any, null as any, mockGetMainWindow as any);
      const nullHandler = handlers.get(IPC_CHANNELS.FILES_READ)!;

      // ValidationError is caught and wrapped in FileSystemError by the handler
      await expect(nullHandler({}, '/home/user/file.txt')).rejects.toThrow(FileSystemError);
    });

    it('should throw when readFile returns null', async () => {
      mockFileWatcher.readFile.mockResolvedValue(null);

      await expect(handler({}, '/home/user/project/file.txt')).rejects.toThrow(FileSystemError);
    });

    it('should throw when readFile returns undefined', async () => {
      mockFileWatcher.readFile.mockResolvedValue(undefined);

      await expect(handler({}, '/home/user/project/file.txt')).rejects.toThrow(FileSystemError);
    });

    it('should return empty string for empty file', async () => {
      mockFileWatcher.readFile.mockResolvedValue('');

      const result = await handler({}, '/home/user/project/empty.txt');

      expect(result).toBe('');
    });

    it('should handle binary-like content', async () => {
      const binaryLike = '\x00\x01\x02\x03';
      mockFileWatcher.readFile.mockResolvedValue(binaryLike);

      const result = await handler({}, '/home/user/project/binary');

      expect(result).toBe(binaryLike);
    });

    it('should propagate file read errors', async () => {
      mockFileWatcher.readFile.mockRejectedValue(new Error('File not found'));

      await expect(handler({}, '/home/user/project/missing.txt')).rejects.toThrow(FileSystemError);
    });
  });

  // ===========================================================================
  // File Change Notifications
  // ===========================================================================
  describe('file change notifications', () => {
    it('should forward file changes to renderer', () => {
      // Ensure callback was captured
      expect(mockFileWatcher._changeCallback).toBeDefined();
      expect(typeof mockFileWatcher._changeCallback).toBe('function');

      const changes = [
        { type: 'add' as const, path: '/home/user/project/new.txt' },
        { type: 'change' as const, path: '/home/user/project/modified.txt' },
      ];

      // Trigger the change callback
      mockFileWatcher._changeCallback!(changes);

      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPC_CHANNELS.FILES_CHANGED,
        changes
      );
    });

    it('should not send notification for null changes', () => {
      expect(mockFileWatcher._changeCallback).toBeDefined();
      mockFileWatcher._changeCallback!(null as any);

      expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('should not send notification for non-array changes', () => {
      expect(mockFileWatcher._changeCallback).toBeDefined();
      mockFileWatcher._changeCallback!('not an array' as any);

      expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('should handle empty changes array', () => {
      expect(mockFileWatcher._changeCallback).toBeDefined();
      mockFileWatcher._changeCallback!([]);

      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPC_CHANNELS.FILES_CHANGED,
        []
      );
    });

    it('should handle all change types', () => {
      expect(mockFileWatcher._changeCallback).toBeDefined();
      const changes = [
        { type: 'add' as const, path: '/added.txt' },
        { type: 'change' as const, path: '/changed.txt' },
        { type: 'unlink' as const, path: '/deleted.txt' },
      ];

      mockFileWatcher._changeCallback!(changes);

      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPC_CHANNELS.FILES_CHANGED,
        changes
      );
    });

    it('should handle window being null during notification', () => {
      expect(mockFileWatcher._changeCallback).toBeDefined();
      mockGetMainWindow.mockReturnValue(null as any);

      // Should not throw
      expect(() => {
        mockFileWatcher._changeCallback!([{ type: 'add', path: '/test.txt' }]);
      }).not.toThrow();
    });
  });
});
