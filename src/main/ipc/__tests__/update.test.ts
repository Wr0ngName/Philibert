/**
 * Comprehensive tests for Update IPC handlers.
 *
 * Tests cover:
 * - UPDATE_CHECK handler for checking updates
 * - UPDATE_DOWNLOAD handler for downloading updates
 * - UPDATE_INSTALL handler for installing updates
 * - Service validation for all handlers
 * - Error propagation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to ensure mocks are available before vi.mock is called
const { mockIpcMainHandle, mockIpcMain } = vi.hoisted(() => {
  const mockIpcMainHandle = vi.fn();
  return {
    mockIpcMainHandle,
    mockIpcMain: {
      handle: mockIpcMainHandle,
      on: vi.fn(),
      removeHandler: vi.fn(),
      removeAllListeners: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
}));

vi.mock('../../utils/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockUpdateService = {
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  installUpdate: vi.fn(),
};

// Import after mocks
import { IPC_CHANNELS, type UpdateCheckResult, UpdateInfo } from '../../../shared/types';
import { AppError } from '../../errors';
import { setupUpdateIPC } from '../update';

// Define handler type to avoid using Function
type IpcHandler = (...args: unknown[]) => unknown;

describe('Update IPC handlers', () => {
  let handlers: Map<string, IpcHandler>;

  const sampleUpdateInfo: UpdateInfo = {
    version: '2.0.0',
    releaseNotes: '- New features\n- Bug fixes',
    releaseDate: '2024-01-15',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();

    // Capture registered handlers
    mockIpcMainHandle.mockImplementation((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    });

    // Default mock implementations
    mockUpdateService.checkForUpdates.mockResolvedValue({ status: 'available', update: sampleUpdateInfo });
    mockUpdateService.downloadUpdate.mockResolvedValue(undefined);
    mockUpdateService.installUpdate.mockReturnValue(undefined);

    // Register handlers
    setupUpdateIPC(mockUpdateService as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Handler Registration
  // ===========================================================================
  describe('handler registration', () => {
    it('should register all update handlers', () => {
      expect(handlers.has(IPC_CHANNELS.UPDATE_CHECK)).toBe(true);
      expect(handlers.has(IPC_CHANNELS.UPDATE_DOWNLOAD)).toBe(true);
      expect(handlers.has(IPC_CHANNELS.UPDATE_INSTALL)).toBe(true);
    });
  });

  // ===========================================================================
  // UPDATE_CHECK
  // ===========================================================================
  describe('UPDATE_CHECK handler', () => {
    let handler: IpcHandler;

    beforeEach(() => {
      handler = handlers.get(IPC_CHANNELS.UPDATE_CHECK)!;
    });

    it.each([
      ['an update', { status: 'available', update: { version: '2.0.0', releaseNotes: 'Major update' } }],
      ['none: up to date', { status: 'up-to-date', latestVersion: '1.0.0' }],
      ['one downloading', { status: 'pending', version: '2.0.0', downloaded: false }],
      ['why none could be found', { status: 'failed', reason: 'no-feed', version: '2.0.0' }],
    ] as [string, UpdateCheckResult][])('answers what the check found: %s', async (_name, found) => {
      mockUpdateService.checkForUpdates.mockResolvedValue(found);

      const result = await handler({});

      expect(mockUpdateService.checkForUpdates).toHaveBeenCalled();
      expect(result).toEqual(found);
    });

    it('should throw when update service is not initialized', async () => {
      handlers.clear();
      setupUpdateIPC(null as any);
      const nullHandler = handlers.get(IPC_CHANNELS.UPDATE_CHECK)!;

      await expect(nullHandler({})).rejects.toThrow(AppError);
    });

    it('should propagate service errors', async () => {
      mockUpdateService.checkForUpdates.mockRejectedValue(new Error('Network error'));

      await expect(handler({})).rejects.toThrow(AppError);
    });

    it('should include error message in thrown error', async () => {
      mockUpdateService.checkForUpdates.mockRejectedValue(new Error('Connection timeout'));

      try {
        await handler({});
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('Connection timeout');
      }
    });
  });

  // ===========================================================================
  // UPDATE_DOWNLOAD
  // ===========================================================================
  describe('UPDATE_DOWNLOAD handler', () => {
    let handler: IpcHandler;

    beforeEach(() => {
      handler = handlers.get(IPC_CHANNELS.UPDATE_DOWNLOAD)!;
    });

    it('should download update', async () => {
      await handler({});

      expect(mockUpdateService.downloadUpdate).toHaveBeenCalled();
    });

    it('should complete without returning value', async () => {
      const result = await handler({});

      expect(result).toBeUndefined();
    });

    it('should throw when update service is not initialized', async () => {
      handlers.clear();
      setupUpdateIPC(null as any);
      const nullHandler = handlers.get(IPC_CHANNELS.UPDATE_DOWNLOAD)!;

      await expect(nullHandler({})).rejects.toThrow(AppError);
    });

    it('should propagate download errors', async () => {
      mockUpdateService.downloadUpdate.mockRejectedValue(new Error('Disk full'));

      await expect(handler({})).rejects.toThrow(AppError);
    });

    it('should propagate network errors', async () => {
      mockUpdateService.downloadUpdate.mockRejectedValue(new Error('Download interrupted'));

      await expect(handler({})).rejects.toThrow(AppError);
    });

    it('should include error message in thrown error', async () => {
      mockUpdateService.downloadUpdate.mockRejectedValue(new Error('Hash mismatch'));

      try {
        await handler({});
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('Hash mismatch');
      }
    });
  });

  // ===========================================================================
  // UPDATE_INSTALL
  // ===========================================================================
  describe('UPDATE_INSTALL handler', () => {
    let handler: IpcHandler;

    beforeEach(() => {
      handler = handlers.get(IPC_CHANNELS.UPDATE_INSTALL)!;
    });

    it('should install update', async () => {
      await handler({});

      expect(mockUpdateService.installUpdate).toHaveBeenCalled();
    });

    it('should complete without returning value', async () => {
      const result = await handler({});

      expect(result).toBeUndefined();
    });

    it('should throw when update service is not initialized', async () => {
      handlers.clear();
      setupUpdateIPC(null as any);
      const nullHandler = handlers.get(IPC_CHANNELS.UPDATE_INSTALL)!;

      // UPDATE_INSTALL is synchronous, so errors are thrown not rejected
      await expect(nullHandler({})).rejects.toThrow(AppError);
    });

    it('should propagate install errors', async () => {
      mockUpdateService.installUpdate.mockImplementation(() => {
        throw new Error('Installation failed');
      });

      // UPDATE_INSTALL is synchronous, so errors are thrown not rejected
      await expect(handler({})).rejects.toThrow(AppError);
    });

    it('should propagate permission errors', async () => {
      mockUpdateService.installUpdate.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      // UPDATE_INSTALL is synchronous, so errors are thrown not rejected
      await expect(handler({})).rejects.toThrow(AppError);
    });

    it('should include error message in thrown error', async () => {
      mockUpdateService.installUpdate.mockImplementation(() => {
        throw new Error('Application in use');
      });

      try {
        await handler({});
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('Application in use');
      }
    });
  });

  // ===========================================================================
  // Error Code Verification
  // ===========================================================================
  describe('error codes', () => {
    it('should include UPDATE_CHECK_FAILED code for check errors', async () => {
      mockUpdateService.checkForUpdates.mockRejectedValue(new Error('Error'));
      const handler = handlers.get(IPC_CHANNELS.UPDATE_CHECK)!;

      try {
        await handler({});
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as AppError).code).toBe('UPDATE_CHECK_FAILED');
      }
    });

    it('should include UPDATE_DOWNLOAD_FAILED code for download errors', async () => {
      mockUpdateService.downloadUpdate.mockRejectedValue(new Error('Error'));
      const handler = handlers.get(IPC_CHANNELS.UPDATE_DOWNLOAD)!;

      try {
        await handler({});
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as AppError).code).toBe('UPDATE_DOWNLOAD_FAILED');
      }
    });

    it('should include UPDATE_INSTALL_FAILED code for install errors', async () => {
      mockUpdateService.installUpdate.mockImplementation(() => {
        throw new Error('Error');
      });
      const handler = handlers.get(IPC_CHANNELS.UPDATE_INSTALL)!;

      try {
        await handler({});
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as AppError).code).toBe('UPDATE_INSTALL_FAILED');
      }
    });
  });
});
