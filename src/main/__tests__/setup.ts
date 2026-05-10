/**
 * Test setup and mock utilities for main process tests.
 *
 * Provides comprehensive mocks for:
 * - Electron APIs (app, BrowserWindow, ipcMain, dialog, shell, safeStorage)
 * - node-pty (PTY process spawning)
 * - electron-store (persistent storage)
 * - File system operations
 */

import { vi } from 'vitest';

// ============================================================================
// Electron Mock Types
// ============================================================================

export interface MockBrowserWindow {
  webContents: {
    send: ReturnType<typeof vi.fn>;
    openDevTools: ReturnType<typeof vi.fn>;
  };
  loadURL: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  minimize: ReturnType<typeof vi.fn>;
  maximize: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  isMaximized: ReturnType<typeof vi.fn>;
  isFocused: ReturnType<typeof vi.fn>;
  isMinimized: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
}

export interface MockIPty {
  pid: number;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
}

export interface MockElectronStore {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  has: ReturnType<typeof vi.fn>;
  store: Record<string, unknown>;
}

// ============================================================================
// Mock Factories
// ============================================================================

/**
 * Create a mock BrowserWindow instance
 */
export function createMockBrowserWindow(): MockBrowserWindow {
  return {
    webContents: {
      send: vi.fn(),
      openDevTools: vi.fn(),
    },
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    close: vi.fn(),
    minimize: vi.fn(),
    maximize: vi.fn(),
    restore: vi.fn(),
    isFocused: vi.fn().mockReturnValue(false),
    isMinimized: vi.fn().mockReturnValue(false),
    isMaximized: vi.fn().mockReturnValue(false),
    isVisible: vi.fn().mockReturnValue(true),
    isDestroyed: vi.fn().mockReturnValue(false),
    on: vi.fn(),
    once: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };
}

/**
 * Create a mock PTY process for AuthService tests
 */
export function createMockPty(options?: {
  pid?: number;
  exitCode?: number;
  outputSequence?: string[];
}): MockIPty {
  const { pid = 12345, exitCode = 0, outputSequence = [] } = options || {};

  let dataCallback: ((data: string) => void) | null = null;
  let exitCallback: ((info: { exitCode: number; signal?: number }) => void) | null = null;
  let outputIndex = 0;

  const mockPty: MockIPty = {
    pid,
    onData: vi.fn((callback) => {
      dataCallback = callback;
      // Emit output sequence if provided
      if (outputSequence.length > 0 && outputIndex < outputSequence.length) {
        setTimeout(() => {
          if (dataCallback && outputIndex < outputSequence.length) {
            dataCallback(outputSequence[outputIndex++]);
          }
        }, 10);
      }
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn((callback) => {
      exitCallback = callback;
      return { dispose: vi.fn() };
    }),
    write: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
  };

  // Helper to emit data manually
  (mockPty as MockIPty & { emitData: (data: string) => void }).emitData = (data: string) => {
    if (dataCallback) {
      dataCallback(data);
    }
  };

  // Helper to trigger exit
  (mockPty as MockIPty & { triggerExit: (code?: number) => void }).triggerExit = (code?: number) => {
    if (exitCallback) {
      exitCallback({ exitCode: code ?? exitCode });
    }
  };

  return mockPty;
}

/**
 * Create a mock electron-store instance
 */
export function createMockElectronStore(initialData?: Record<string, unknown>): MockElectronStore {
  const store: Record<string, unknown> = { ...initialData };

  return {
    get: vi.fn((key: string, defaultValue?: unknown) => {
      return key in store ? store[key] : defaultValue;
    }),
    set: vi.fn((key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === 'object') {
        Object.assign(store, key);
      } else {
        store[key] = value;
      }
    }),
    delete: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      Object.keys(store).forEach((key) => delete store[key]);
    }),
    has: vi.fn((key: string) => key in store),
    store,
  };
}

// ============================================================================
// Electron Module Mocks
// ============================================================================

/**
 * Mock Electron app module
 */
export const mockApp = {
  getPath: vi.fn((name: string) => {
    const paths: Record<string, string> = {
      userData: '/mock/user/data',
      home: '/mock/home',
      temp: '/mock/temp',
      appData: '/mock/appData',
    };
    return paths[name] || `/mock/${name}`;
  }),
  getAppPath: vi.fn(() => '/mock/app'),
  quit: vi.fn(),
  on: vi.fn(),
  once: vi.fn(),
  whenReady: vi.fn().mockResolvedValue(undefined),
  isReady: vi.fn().mockReturnValue(true),
  getName: vi.fn().mockReturnValue('philibert'),
  getVersion: vi.fn().mockReturnValue('0.1.0'),
};

/**
 * Mock Electron dialog module
 */
export const mockDialog = {
  showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/mock/selected/path'] }),
  showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath: '/mock/save/path' }),
  showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
  showErrorBox: vi.fn(),
};

/**
 * Mock Electron shell module
 */
export const mockShell = {
  openExternal: vi.fn().mockResolvedValue(undefined),
  openPath: vi.fn().mockResolvedValue(''),
  showItemInFolder: vi.fn(),
};

/**
 * Mock Electron safeStorage module
 */
export const mockSafeStorage = {
  isEncryptionAvailable: vi.fn().mockReturnValue(true),
  encryptString: vi.fn((text: string) => Buffer.from(`encrypted:${text}`)),
  decryptString: vi.fn((buffer: Buffer) => {
    const str = buffer.toString();
    if (str.startsWith('encrypted:')) {
      return str.slice(10);
    }
    throw new Error('Invalid encrypted data');
  }),
};

/**
 * Mock Electron ipcMain module
 */
export const mockIpcMain = {
  handle: vi.fn(),
  handleOnce: vi.fn(),
  on: vi.fn(),
  once: vi.fn(),
  removeHandler: vi.fn(),
  removeAllListeners: vi.fn(),
  removeListener: vi.fn(),
};

/**
 * Mock Electron BrowserWindow class
 */
export const MockBrowserWindowClass = vi.fn(() => createMockBrowserWindow());
(MockBrowserWindowClass as unknown as { getAllWindows: ReturnType<typeof vi.fn> }).getAllWindows = vi.fn().mockReturnValue([]);

// ============================================================================
// File System Mocks
// ============================================================================

export interface MockFileSystem {
  files: Map<string, string | Buffer>;
  directories: Set<string>;
  addFile: (path: string, content: string | Buffer) => void;
  addDirectory: (path: string) => void;
  removeFile: (path: string) => void;
  clear: () => void;
}

/**
 * Create a mock file system for testing
 */
export function createMockFileSystem(): MockFileSystem {
  const files = new Map<string, string | Buffer>();
  const directories = new Set<string>();

  // Add root directories
  directories.add('/');
  directories.add('/mock');

  return {
    files,
    directories,
    addFile: (path: string, content: string | Buffer) => {
      files.set(path, content);
      // Add parent directories
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        directories.add(parts.slice(0, i).join('/') || '/');
      }
    },
    addDirectory: (path: string) => {
      directories.add(path);
      // Add parent directories
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        directories.add(parts.slice(0, i).join('/') || '/');
      }
    },
    removeFile: (path: string) => {
      files.delete(path);
    },
    clear: () => {
      files.clear();
      directories.clear();
      directories.add('/');
    },
  };
}

/**
 * Create fs mock functions based on MockFileSystem
 */
export function createFsMocks(mockFs: MockFileSystem) {
  return {
    existsSync: vi.fn((path: string) => {
      return mockFs.files.has(path) || mockFs.directories.has(path);
    }),
    readFileSync: vi.fn((path: string, encoding?: string) => {
      const content = mockFs.files.get(path);
      if (content === undefined) {
        const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      if (encoding === 'utf8' || encoding === 'utf-8') {
        return content.toString();
      }
      return content;
    }),
    writeFileSync: vi.fn((path: string, content: string | Buffer) => {
      mockFs.addFile(path, content);
    }),
    mkdirSync: vi.fn((path: string, options?: { recursive?: boolean }) => {
      if (options?.recursive) {
        const parts = path.split('/');
        for (let i = 1; i <= parts.length; i++) {
          mockFs.directories.add(parts.slice(0, i).join('/') || '/');
        }
      } else {
        mockFs.directories.add(path);
      }
    }),
    rmSync: vi.fn((path: string) => {
      mockFs.files.delete(path);
      mockFs.directories.delete(path);
    }),
    readdirSync: vi.fn((path: string, options?: { withFileTypes?: boolean }) => {
      const entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
      const normalizedPath = path.endsWith('/') ? path.slice(0, -1) : path;

      // Find all files and directories directly under this path
      for (const filePath of mockFs.files.keys()) {
        if (filePath.startsWith(normalizedPath + '/')) {
          const relativePath = filePath.slice(normalizedPath.length + 1);
          const firstPart = relativePath.split('/')[0];
          if (!relativePath.includes('/')) {
            entries.push({
              name: firstPart,
              isDirectory: () => false,
              isFile: () => true,
            });
          }
        }
      }

      for (const dirPath of mockFs.directories) {
        if (dirPath.startsWith(normalizedPath + '/') && dirPath !== normalizedPath) {
          const relativePath = dirPath.slice(normalizedPath.length + 1);
          if (!relativePath.includes('/')) {
            entries.push({
              name: relativePath,
              isDirectory: () => true,
              isFile: () => false,
            });
          }
        }
      }

      if (options?.withFileTypes) {
        return entries;
      }
      return entries.map((e) => e.name);
    }),
    statSync: vi.fn((path: string) => {
      if (mockFs.files.has(path)) {
        const content = mockFs.files.get(path)!;
        return {
          isDirectory: () => false,
          isFile: () => true,
          size: typeof content === 'string' ? content.length : content.length,
          mtimeMs: Date.now(),
        };
      }
      if (mockFs.directories.has(path)) {
        return {
          isDirectory: () => true,
          isFile: () => false,
          size: 0,
          mtimeMs: Date.now(),
        };
      }
      const error = new Error(`ENOENT: no such file or directory, stat '${path}'`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }),
    accessSync: vi.fn((path: string) => {
      if (!mockFs.files.has(path) && !mockFs.directories.has(path)) {
        const error = new Error(`ENOENT: no such file or directory, access '${path}'`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
    }),
    promises: {
      readFile: vi.fn(async (path: string, encoding?: string) => {
        const content = mockFs.files.get(path);
        if (content === undefined) {
          const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }
        if (encoding === 'utf8' || encoding === 'utf-8') {
          return content.toString();
        }
        return content;
      }),
      writeFile: vi.fn(async (path: string, content: string | Buffer) => {
        mockFs.addFile(path, content);
      }),
      mkdir: vi.fn(async (path: string, options?: { recursive?: boolean }) => {
        if (options?.recursive) {
          const parts = path.split('/');
          for (let i = 1; i <= parts.length; i++) {
            mockFs.directories.add(parts.slice(0, i).join('/') || '/');
          }
        } else {
          mockFs.directories.add(path);
        }
      }),
      rm: vi.fn(async (path: string) => {
        mockFs.files.delete(path);
        mockFs.directories.delete(path);
      }),
      readdir: vi.fn(async (path: string, options?: { withFileTypes?: boolean }) => {
        const entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
        const normalizedPath = path.endsWith('/') ? path.slice(0, -1) : path;

        for (const filePath of mockFs.files.keys()) {
          if (filePath.startsWith(normalizedPath + '/')) {
            const relativePath = filePath.slice(normalizedPath.length + 1);
            if (!relativePath.includes('/')) {
              entries.push({
                name: relativePath,
                isDirectory: () => false,
                isFile: () => true,
              });
            }
          }
        }

        for (const dirPath of mockFs.directories) {
          if (dirPath.startsWith(normalizedPath + '/') && dirPath !== normalizedPath) {
            const relativePath = dirPath.slice(normalizedPath.length + 1);
            if (!relativePath.includes('/')) {
              entries.push({
                name: relativePath,
                isDirectory: () => true,
                isFile: () => false,
              });
            }
          }
        }

        if (options?.withFileTypes) {
          return entries;
        }
        return entries.map((e) => e.name);
      }),
      stat: vi.fn(async (path: string) => {
        if (mockFs.files.has(path)) {
          const content = mockFs.files.get(path)!;
          return {
            isDirectory: () => false,
            isFile: () => true,
            size: typeof content === 'string' ? content.length : content.length,
            mtimeMs: Date.now(),
          };
        }
        if (mockFs.directories.has(path)) {
          return {
            isDirectory: () => true,
            isFile: () => false,
            size: 0,
            mtimeMs: Date.now(),
          };
        }
        const error = new Error(`ENOENT: no such file or directory, stat '${path}'`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }),
      access: vi.fn(async (path: string) => {
        if (!mockFs.files.has(path) && !mockFs.directories.has(path)) {
          const error = new Error(`ENOENT: no such file or directory, access '${path}'`) as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }
      }),
    },
    watch: vi.fn(() => ({
      close: vi.fn(),
      on: vi.fn(),
    })),
  };
}

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Wait for a condition to be true, with timeout
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options?: { timeout?: number; interval?: number }
): Promise<void> {
  const { timeout = 5000, interval = 50 } = options || {};
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`waitFor timed out after ${timeout}ms`);
}

/**
 * Create a deferred promise for testing async flows
 */
export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

/**
 * Flush all pending promises (useful for testing async code)
 */
export async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Create a spy that tracks all calls and allows assertions
 */
export function createCallTracker<T extends (...args: unknown[]) => unknown>() {
  const calls: Array<{ args: Parameters<T>; result?: ReturnType<T>; error?: Error }> = [];

  const tracker = vi.fn((...args: Parameters<T>) => {
    const call = { args } as (typeof calls)[0];
    calls.push(call);
    return call;
  });

  return {
    fn: tracker,
    calls,
    getCall: (index: number) => calls[index],
    getLastCall: () => calls[calls.length - 1],
    wasCalled: () => calls.length > 0,
    wasCalledWith: (...args: Parameters<T>) =>
      calls.some((call) => JSON.stringify(call.args) === JSON.stringify(args)),
    callCount: () => calls.length,
    reset: () => {
      calls.length = 0;
      tracker.mockClear();
    },
  };
}

// ============================================================================
// Global Test Setup
// ============================================================================

/**
 * Setup all mocks for a main process test
 */
export function setupMainProcessMocks() {
  const mockFs = createMockFileSystem();
  const fsMocks = createFsMocks(mockFs);
  const mockWindow = createMockBrowserWindow();
  const mockStore = createMockElectronStore();

  return {
    mockFs,
    fsMocks,
    mockWindow,
    mockStore,
    mockApp,
    mockDialog,
    mockShell,
    mockSafeStorage,
    mockIpcMain,
    MockBrowserWindowClass,
    getMainWindow: vi.fn(() => mockWindow as unknown as null),
  };
}
