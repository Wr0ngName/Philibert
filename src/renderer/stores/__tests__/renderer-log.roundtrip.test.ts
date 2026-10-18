/**
 * A renderer failure ends up in main.log.
 *
 * Reported as: "Failed to send message to Claude", and nothing in the logs.
 * The send had thrown in the renderer, whose console is only visible with
 * devtools open, so the one log a user can hand over showed no error at all.
 *
 * Real renderer logger, real preload, real main-process log handler; only
 * Electron, the filesystem and the main logger's file transport are faked —
 * the last one is what this asserts on.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mainLog } = vi.hoisted(() => ({
  mainLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('node:fs', async () => (await import('./support/real-stack')).fakeFsModule());
vi.mock('electron', async () => (await import('./support/real-stack')).fakeElectronModule());
vi.mock('../../../main/utils/paths', () => ({
  getConversationsPath: () => '/conversations',
  isPathWithin: (target: string, root: string) => target.startsWith(root),
}));
vi.mock('../../../main/utils/logger', () => ({ default: mainLog, setLogLevel: vi.fn() }));

import { RENDERER_LOG_LIMITS, setupLogIPC } from '../../../main/ipc/log';
import { ConversationService } from '../../../main/services/ConversationService';
import '../../../preload/preload';
import ChatWindow from '../../components/chat/ChatWindow.vue';
import { installGlobalErrorLogging, logger } from '../../utils/logger';
import { useChatStore } from '../chat';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import { startRealStack, settle, mainHandlers, mountApp, unmountApp, send } from './support/real-stack';

/** Every line the renderer had written to main.log, at that level. */
function rendererLines(level: 'warn' | 'error' | 'info' | 'debug'): string[] {
  return mainLog[level].mock.calls
    .filter(([line]) => typeof line === 'string' && line.startsWith('[renderer]'))
    .map((call) => call.map(String).join(' '));
}

describe('renderer warnings and errors in main.log', () => {
  beforeEach(async () => {
    await startRealStack({ ConversationService: ConversationService as unknown as new () => never });
    setupLogIPC();
    for (const fn of Object.values(mainLog)) fn.mockClear();
    // The console copy is still written; kept out of the test output.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    unmountApp();
    vi.restoreAllMocks();
  });

  it('records a send that failed, with the reason', async () => {
    const settings = useSettingsStore();
    settings.config.workingDirectory = '/home/user/project';
    settings.config.apiKey = 'test-key';
    const store = useConversationsStore();
    store.currentConversationId = 'conv-log';
    useChatStore().setCurrentConversation('conv-log');
    mainHandlers.set('claude:send', () => {
      throw new Error('An object could not be cloned.');
    });
    const wrapper = mountApp(ChatWindow);

    await send(wrapper, 'hello');
    await settle();

    expect(useChatStore().error).toBe('Failed to send message to Claude');
    const lines = rendererLines('error');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[renderer] Failed to send message');
    expect(lines[0]).toContain('An object could not be cloned.');
    // The stack, so the line says where as well as what.
    expect(lines[0]).toContain('"stack"');
  });

  it('records warnings, and leaves debug and info to the console', () => {
    logger.warn('a warning', { count: 2 });
    logger.info('some info', { count: 3 });
    logger.debug('some detail');

    expect(rendererLines('warn')).toEqual(['[renderer] a warning {"count":2}']);
    expect(rendererLines('info')).toEqual([]);
    expect(rendererLines('debug')).toEqual([]);
  });

  it('writes what was logged, not "[object Object]"', () => {
    // An error inside an object, and a cycle — both of which the old
    // formatting lost or threw on.
    const cyclic: Record<string, unknown> = { name: 'node' };
    cyclic.self = cyclic;
    logger.error('Failed to attach an image', { err: new Error('decode failed'), cyclic });

    const [line] = rendererLines('error');
    expect(line).toContain('decode failed');
    expect(line).toContain('[Circular]');
    expect(line).not.toContain('[object Object]');
  });

  it('records errors thrown outside a component and promises nobody awaited', () => {
    const target = new EventTarget();
    installGlobalErrorLogging(target as unknown as Window);

    target.dispatchEvent(Object.assign(new Event('error'), {
      error: new Error('listener blew up'), message: 'listener blew up',
      filename: 'app://renderer/index.js', lineno: 12, colno: 34,
    }));
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), {
      reason: new Error('nobody awaited this'),
    }));

    const lines = rendererLines('error');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[renderer] Uncaught error');
    expect(lines[0]).toContain('listener blew up');
    expect(lines[0]).toContain('app://renderer/index.js:12:34');
    expect(lines[1]).toContain('[renderer] Unhandled promise rejection');
    expect(lines[1]).toContain('nobody awaited this');
  });

  it('clips a runaway line rather than writing all of it', () => {
    logger.error('x'.repeat(RENDERER_LOG_LIMITS.message + 500), { blob: 'y'.repeat(RENDERER_LOG_LIMITS.data * 2) });

    const [message, data] = mainLog.error.mock.calls[0] as [string, string];
    expect(message.length).toBeLessThan(RENDERER_LOG_LIMITS.message + 100);
    expect(message).toContain('500 more chars');
    expect(data.length).toBeLessThan(RENDERER_LOG_LIMITS.data + 100);
  });

  it('writes nothing for an entry that is not a warning or an error', () => {
    const write = window.electron.log.write as (entry: unknown) => void;
    write({ level: 'info', message: 'not ours to write' });
    write({ level: 'error', message: 42 });
    write(null);
    write('error');

    expect(Object.values(mainLog).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it('never throws because logging failed', () => {
    const real = window.electron;
    try {
      (window as unknown as { electron: unknown }).electron = {
        log: { write: () => { throw new Error('channel closed'); } },
      };
      expect(() => logger.error('still fine')).not.toThrow();
      (window as unknown as { electron: unknown }).electron = undefined;
      expect(() => logger.warn('no bridge at all')).not.toThrow();
    } finally {
      (window as unknown as { electron: unknown }).electron = real;
    }
  });
});
