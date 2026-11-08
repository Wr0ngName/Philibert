/**
 * Comprehensive tests for Window IPC handlers.
 *
 * Tests cover:
 * - WINDOW_MINIMIZE handler
 * - WINDOW_MAXIMIZE handler (toggle behavior)
 * - WINDOW_CLOSE handler
 * - Error handling (non-throwing behavior for ipcMain.on)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to ensure mocks are available before vi.mock is called
const {
  mockIpcMainOn,
  mockIpcMain,
  mockMinimizeWindow,
  mockMaximizeWindow,
  mockCloseWindow,
  mockSetAttentionNeeded,
} = vi.hoisted(() => {
  const mockIpcMainOn = vi.fn();
  return {
    mockIpcMainOn,
    mockIpcMain: {
      handle: vi.fn(),
      on: mockIpcMainOn,
      removeHandler: vi.fn(),
      removeAllListeners: vi.fn(),
    },
    mockMinimizeWindow: vi.fn(),
    mockMaximizeWindow: vi.fn(),
    mockCloseWindow: vi.fn(),
    mockSetAttentionNeeded: vi.fn(),
  };
});

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
}));

vi.mock('../../window', () => ({
  minimizeWindow: mockMinimizeWindow,
  maximizeWindow: mockMaximizeWindow,
  closeWindow: mockCloseWindow,
  setAttentionNeeded: mockSetAttentionNeeded,
}));

vi.mock('../../utils/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocks
import { IPC_CHANNELS } from '../../../shared/types';
import logger from '../../utils/logger';
import { setupWindowIPC } from '../window';

// Define handler type to avoid using Function
type IpcHandler = (...args: unknown[]) => unknown;

describe('Window IPC handlers', () => {
  let handlers: Map<string, IpcHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();

    // Capture registered handlers
    mockIpcMainOn.mockImplementation((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    });

    // Default mock implementations
    mockMinimizeWindow.mockReturnValue(undefined);
    mockMaximizeWindow.mockReturnValue(undefined);
    mockCloseWindow.mockReturnValue(undefined);

    // Register handlers
    setupWindowIPC();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Handler Registration
  // ===========================================================================
  describe('handler registration', () => {
    it('should register all window handlers with ipcMain.on (not handle)', () => {
      expect(mockIpcMainOn).toHaveBeenCalledWith(IPC_CHANNELS.WINDOW_MINIMIZE, expect.any(Function));
      expect(mockIpcMainOn).toHaveBeenCalledWith(IPC_CHANNELS.WINDOW_MAXIMIZE, expect.any(Function));
      expect(mockIpcMainOn).toHaveBeenCalledWith(IPC_CHANNELS.WINDOW_CLOSE, expect.any(Function));
    });

    it('should register handlers as one-way messages (not request-response)', () => {
      // ipcMain.on is for one-way messages, ipcMain.handle is for request-response
      expect(handlers.has(IPC_CHANNELS.WINDOW_MINIMIZE)).toBe(true);
      expect(handlers.has(IPC_CHANNELS.WINDOW_MAXIMIZE)).toBe(true);
      expect(handlers.has(IPC_CHANNELS.WINDOW_CLOSE)).toBe(true);
    });
  });

  // ===========================================================================
  // WINDOW_ATTENTION
  // ===========================================================================
  describe('WINDOW_ATTENTION handler', () => {
    it('passes on whether something waits on the user', () => {
      const handler = handlers.get(IPC_CHANNELS.WINDOW_ATTENTION)!;

      handler({}, true);
      handler({}, false);

      expect(mockSetAttentionNeeded.mock.calls).toEqual([[true], [false]]);
    });

    it('takes anything but true for nothing waiting', () => {
      const handler = handlers.get(IPC_CHANNELS.WINDOW_ATTENTION)!;

      handler({}, 'yes');

      expect(mockSetAttentionNeeded).toHaveBeenCalledWith(false);
    });
  });

  // ===========================================================================
  // WINDOW_MINIMIZE
  // ===========================================================================
  describe('WINDOW_MINIMIZE handler', () => {
    let handler: IpcHandler;

    beforeEach(() => {
      handler = handlers.get(IPC_CHANNELS.WINDOW_MINIMIZE)!;
    });

    it('should call minimizeWindow', () => {
      handler();

      expect(mockMinimizeWindow).toHaveBeenCalled();
    });

    it('should not throw on error', () => {
      mockMinimizeWindow.mockImplementation(() => {
        throw new Error('Window not available');
      });

      // Should not throw
      expect(() => handler()).not.toThrow();
    });

    it('should log errors without throwing', () => {
      mockMinimizeWindow.mockImplementation(() => {
        throw new Error('Window not available');
      });

      handler();

      expect(logger.error).toHaveBeenCalledWith('Failed to minimize window', expect.any(Object));
    });
  });

  // ===========================================================================
  // WINDOW_MAXIMIZE
  // ===========================================================================
  describe('WINDOW_MAXIMIZE handler', () => {
    let handler: IpcHandler;

    beforeEach(() => {
      handler = handlers.get(IPC_CHANNELS.WINDOW_MAXIMIZE)!;
    });

    it('should call maximizeWindow', () => {
      handler();

      expect(mockMaximizeWindow).toHaveBeenCalled();
    });

    it('should not throw on error', () => {
      mockMaximizeWindow.mockImplementation(() => {
        throw new Error('Window not available');
      });

      // Should not throw
      expect(() => handler()).not.toThrow();
    });

    it('should log errors without throwing', () => {
      mockMaximizeWindow.mockImplementation(() => {
        throw new Error('Window not available');
      });

      handler();

      expect(logger.error).toHaveBeenCalledWith('Failed to maximize window', expect.any(Object));
    });
  });

  // ===========================================================================
  // WINDOW_CLOSE
  // ===========================================================================
  describe('WINDOW_CLOSE handler', () => {
    let handler: IpcHandler;

    beforeEach(() => {
      handler = handlers.get(IPC_CHANNELS.WINDOW_CLOSE)!;
    });

    it('should call closeWindow', () => {
      handler();

      expect(mockCloseWindow).toHaveBeenCalled();
    });

    it('should not throw on error', () => {
      mockCloseWindow.mockImplementation(() => {
        throw new Error('Window not available');
      });

      // Should not throw
      expect(() => handler()).not.toThrow();
    });

    it('should log errors without throwing', () => {
      mockCloseWindow.mockImplementation(() => {
        throw new Error('Window not available');
      });

      handler();

      expect(logger.error).toHaveBeenCalledWith('Failed to close window', expect.any(Object));
    });
  });

  // ===========================================================================
  // Logging
  // ===========================================================================
  describe('logging', () => {
    it('should log debug message for minimize', () => {
      const handler = handlers.get(IPC_CHANNELS.WINDOW_MINIMIZE)!;
      handler();

      expect(logger.debug).toHaveBeenCalledWith('IPC: window:minimize');
    });

    it('should log debug message for maximize', () => {
      const handler = handlers.get(IPC_CHANNELS.WINDOW_MAXIMIZE)!;
      handler();

      expect(logger.debug).toHaveBeenCalledWith('IPC: window:maximize');
    });

    it('should log debug message for close', () => {
      const handler = handlers.get(IPC_CHANNELS.WINDOW_CLOSE)!;
      handler();

      expect(logger.debug).toHaveBeenCalledWith('IPC: window:close');
    });

    it('should log info message on handler registration', () => {
      expect(logger.info).toHaveBeenCalledWith('Window IPC handlers registered');
    });
  });

  // ===========================================================================
  // Multiple Calls
  // ===========================================================================
  describe('multiple calls', () => {
    it('should handle rapid minimize calls', () => {
      const handler = handlers.get(IPC_CHANNELS.WINDOW_MINIMIZE)!;

      for (let i = 0; i < 10; i++) {
        handler();
      }

      expect(mockMinimizeWindow).toHaveBeenCalledTimes(10);
    });

    it('should handle rapid maximize toggle calls', () => {
      const handler = handlers.get(IPC_CHANNELS.WINDOW_MAXIMIZE)!;

      for (let i = 0; i < 10; i++) {
        handler();
      }

      expect(mockMaximizeWindow).toHaveBeenCalledTimes(10);
    });

    it('should handle interleaved window operations', () => {
      const minimizeHandler = handlers.get(IPC_CHANNELS.WINDOW_MINIMIZE)!;
      const maximizeHandler = handlers.get(IPC_CHANNELS.WINDOW_MAXIMIZE)!;

      minimizeHandler();
      maximizeHandler();
      minimizeHandler();
      maximizeHandler();

      expect(mockMinimizeWindow).toHaveBeenCalledTimes(2);
      expect(mockMaximizeWindow).toHaveBeenCalledTimes(2);
    });
  });
});
