/**
 * The real renderer, against the real persistence, with only the genuinely
 * external things faked.
 *
 * Extracted from conversation-persistence.roundtrip.test.ts, which was written
 * because the suites around it asserted against hand-written fakes of our own
 * preload API — and every data-loss defect this app has shipped lived in the
 * seams those fakes replaced: the save queue, the background buffer, the switch
 * sequence, the file on disk. A fake of our own boundary cannot see any of
 * them, and worse, it keeps passing while the product breaks.
 *
 * What is real here: both stores, the real `ChatWindow`, the real preload (so
 * `window.electron` is the shipped surface), the real IPC channel names, and
 * the real main-process ConversationService — conversations are really
 * serialised, written, read back and parsed.
 *
 * What is faked, and why that is allowed: Electron itself and the filesystem.
 * Both are outside this codebase.
 *
 * What is NOT covered: the Claude SDK (no turn really runs; turn events are
 * delivered the way the main process delivers them) and Electron's process
 * lifecycle.
 */

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

import type { Conversation, ConversationUpdate } from '@shared/types';

/** The "disk": path → file contents. */
export const files = new Map<string, string>();

/** Channel → IPC listeners registered by the renderer. */
export const ipcListeners = new Map<string, ((event: unknown, ...args: unknown[]) => void)[]>();

/** Filled by importing the real preload. */
export const exposed = { api: null as Record<string, unknown> | null };

/**
 * Control over how the disk behaves.
 *
 * `holdWrites`: an in-memory write finishes within the same tick, which
 * quietly removed a whole class of defect from reach — saves could never
 * actually overlap, so a "refuse to save while one is in flight" guard left
 * every assertion passing. A real write takes long enough for the next one to
 * be requested while it is still going, and that is exactly when messages
 * were lost.
 *
 * `failWrites`: the reported loss came from the app's own refusal to write,
 * and a locked file, a full disk, a timeout or antivirus holding the handle
 * all arrive at the renderer identically. What the renderer does with
 * messages it failed to persist cannot be tested while every write succeeds.
 */
export const disk = {
  holdWrites: false,
  failWrites: false,
  /** Fail this many upcoming writes, then succeed again. */
  failNext: 0,
  /** Writes that actually landed, for asserting how many a save cost. */
  writes: 0,
  waiting: [] as (() => void)[],
  /** Deleting a conversation file fails while this is set. */
  failUnlink: false,
  /** Reads hang until `releaseReads` while this is set. */
  holdReads: false,
  /** Reads reject while this is set, as an unreadable file does. */
  failReads: false,
  readWaiting: [] as (() => void)[],
};

/** The node:fs surface the real ConversationService uses. */
export function fakeFsModule(): Record<string, unknown> {
  const dirs = new Set<string>(['/conversations']);
  const api = {
    // The real service checks writability with fs.constants.W_OK. Leaving
    // these out made every save throw a TypeError that the service logged and
    // swallowed — a reminder that a fake of an external module has to match
    // the real module, not only the calls one expects.
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
    existsSync: (p: string) => dirs.has(p) || files.has(p),
    mkdirSync: (p: string) => {
      dirs.add(p);
    },
    promises: {
      readdir: async () => {
        if (disk.holdReads) {
          await new Promise<void>((resolve) => disk.readWaiting.push(resolve));
        }
        if (disk.failReads) {
          const err = new Error('EIO: i/o error, scandir') as NodeJS.ErrnoException;
          err.code = 'EIO';
          throw err;
        }
        return [...files.keys()].map((p) => p.split('/').pop() as string);
      },
      readFile: async (p: string) => {
        if (disk.holdReads) {
          await new Promise<void>((resolve) => disk.readWaiting.push(resolve));
        }
        if (disk.failReads) {
          const err = new Error(`EIO: i/o error, read '${p}'`) as NodeJS.ErrnoException;
          err.code = 'EIO';
          throw err;
        }
        const content = files.get(p);
        if (content === undefined) {
          const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return content;
      },
      writeFile: async (p: string, content: string) => {
        if (disk.holdWrites) {
          await new Promise<void>((resolve) => disk.waiting.push(resolve));
        }
        if (disk.failWrites || disk.failNext > 0) {
          if (disk.failNext > 0) disk.failNext -= 1;
          const err = new Error(`EBUSY: resource busy or locked, open '${p}'`) as NodeJS.ErrnoException;
          err.code = 'EBUSY';
          throw err;
        }
        disk.writes += 1;
        files.set(p, content);
      },
      unlink: async (p: string) => {
        if (disk.failUnlink) {
          const err = new Error(`EPERM: operation not permitted, unlink '${p}'`) as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        }
        files.delete(p);
      },
      access: async (p: string) => {
        if (!dirs.has(p) && !files.has(p)) {
          const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
      },
      mkdir: async (p: string) => {
        dirs.add(p);
      },
      stat: async () => ({ isDirectory: () => true, size: 0 }),
    },
  };
  return { default: api, ...api };
}

/** The electron surface the real preload and main services use. */
export function fakeElectronModule(): Record<string, unknown> {
  return {
    contextBridge: {
      exposeInMainWorld: (_key: string, api: Record<string, unknown>) => {
        exposed.api = api;
      },
    },
    ipcRenderer: {
      invoke: async (channel: string, ...args: unknown[]) => route(channel, args),
      send: () => {},
      on: (channel: string, handler: (event: unknown, ...args: unknown[]) => void) => {
        const list = ipcListeners.get(channel) ?? [];
        list.push(handler);
        ipcListeners.set(channel, list);
      },
      removeListener: (channel: string, handler: (event: unknown, ...args: unknown[]) => void) => {
        const list = ipcListeners.get(channel) ?? [];
        const i = list.indexOf(handler);
        if (i >= 0) list.splice(i, 1);
      },
    },
    ipcMain: {
      // Recorded, so the test can route through the REAL main-process
      // handlers: their validation and their error wrapping are part of what
      // the renderer sees, and routing straight to the service skips both.
      handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
        mainHandlers.set(channel, handler);
      },
      on: () => {},
      removeHandler: (channel: string) => {
        mainHandlers.delete(channel);
      },
      removeAllListeners: () => {},
    },
    BrowserWindow: class {},
    app: { getPath: () => '/tmp', getName: () => 'philibert', getVersion: () => '0.0.0' },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (v: string) => Buffer.from(v),
      decryptString: (b: Buffer) => b.toString(),
    },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    shell: { openExternal: async () => {} },
  };
}

/** Channel → the real main-process handler, as registered by ipcMain.handle. */
export const mainHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

/** The real main-process service, constructed by `startRealStack`. */
let conversationService: {
  save: (c: Conversation) => Promise<void>;
  update: (u: ConversationUpdate) => Promise<void>;
  get: (id: string) => Promise<Conversation | null>;
  getWindow: (id: string, limit: number) => Promise<unknown>;
  getOlder: (id: string, beforeId: string, limit: number) => Promise<unknown>;
  list: () => Promise<Conversation[]>;
  delete: (id: string) => Promise<void>;
} | null = null;

/** Config the renderer reads at startup, as the main process would supply it. */
export let storedConfig: Record<string, unknown> = {};

export function setStoredConfig(next: Record<string, unknown>): void {
  storedConfig = next;
}

/**
 * The IPC transport. Conversation channels reach the real service; the rest
 * answer the way the main process would, since no SDK runs here.
 */
export async function route(channel: string, args: unknown[]): Promise<unknown> {
  // The real handler when one is registered: it validates its input and wraps
  // failures the way the renderer actually receives them.
  const handler = mainHandlers.get(channel);
  if (handler) return handler({}, ...args);

  const service = conversationService;
  if (service) {
    switch (channel) {
      case 'conversation:save':
        return service.save(args[0] as Conversation);
      case 'conversation:update':
        return service.update(args[0] as ConversationUpdate);
      case 'conversation:get':
        return service.get(args[0] as string);
      case 'conversation:get-window':
        return service.getWindow(args[0] as string, args[1] as number);
      case 'conversation:get-older':
        return service.getOlder(args[0] as string, args[1] as string, args[2] as number);
      case 'conversation:list':
        return service.list();
      case 'conversation:delete':
        return service.delete(args[0] as string);
      default:
        break;
    }
  }

  switch (channel) {
    case 'config:get':
      return storedConfig;
    case 'config:set':
      storedConfig = { ...storedConfig, ...(args[0] as Record<string, unknown>) };
      return undefined;
    default:
      if (/availability/i.test(channel)) return { available: false };
      if (/commands|models|list|queries|permissions/i.test(channel)) return [];
      return undefined;
  }
}

/** Let promise callbacks run. */
export async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await nextTick();
}

/** Let every held write complete. */
export async function releaseWrites(): Promise<void> {
  disk.holdWrites = false;
  const waiting = [...disk.waiting];
  disk.waiting.length = 0;
  for (const resolve of waiting) resolve();
  await settle(12);
}

/** Let every held read complete. */
export async function releaseReads(): Promise<void> {
  disk.holdReads = false;
  const waiting = [...disk.readWaiting];
  disk.readWaiting.length = 0;
  for (const resolve of waiting) resolve();
  await settle(12);
}

/** Deliver an IPC event the way the main process does. */
export function emitIpc(channel: string, ...args: unknown[]): void {
  for (const handler of [...(ipcListeners.get(channel) ?? [])]) {
    handler({}, ...args);
  }
}

/** What is actually on disk for a conversation, parsed from its JSON. */
export function onDisk(id: string): Conversation | null {
  const raw = files.get(`/conversations/${id}.json`);
  return raw ? (JSON.parse(raw) as Conversation) : null;
}

/** The contents of each stored message, in order. */
export function diskContents(id: string): string[] {
  return (onDisk(id)?.messages ?? []).map((m) => m.content);
}

/**
 * Reset to an empty disk and a fresh renderer, and construct the real
 * service. Call from `beforeEach` after the module mocks are in place.
 */
export async function startRealStack(options: {
  ConversationService: new () => never;
  /**
   * The real `setupConversationIPC`. Passed in rather than imported here so
   * this module stays free of main-process imports that each test file mocks
   * differently; when given, requests go through the real handlers.
   */
  setupConversationIPC?: (service: never) => void;
  workingDirectory?: string;
}): Promise<void> {
  setActivePinia(createPinia());
  files.clear();
  ipcListeners.clear();
  disk.holdWrites = false;
  disk.failWrites = false;
  disk.failNext = 0;
  disk.writes = 0;
  disk.waiting.length = 0;
  disk.failUnlink = false;
  disk.holdReads = false;
  disk.failReads = false;
  disk.readWaiting.length = 0;

  if (!exposed.api) throw new Error('preload did not expose its API — import it in the test file');
  (globalThis as unknown as { window: Record<string, unknown> }).window.electron = exposed.api;

  mainHandlers.clear();
  conversationService = new options.ConversationService() as unknown as typeof conversationService;
  // Register the real conversation handlers against it, when the caller
  // supplied them.
  options.setupConversationIPC?.(conversationService as never);

  storedConfig = {
    workingDirectory: options.workingDirectory ?? '/home/user/project',
    apiKey: 'test-key',
    recentProjects: [],
    theme: 'system',
  };
}

let mounted: ReturnType<typeof mount> | null = null;

/** Mount the real ChatWindow, so the real IPC handlers in useClaudeChat run. */
export function mountApp(ChatWindow: Parameters<typeof mount>[0]): ReturnType<typeof mount> {
  const wrapper = mount(ChatWindow);
  if (!ipcListeners.has('claude:done')) {
    throw new Error('useClaudeChat did not subscribe — mount failed silently');
  }
  mounted = wrapper;
  return wrapper;
}

export function unmountApp(): void {
  mounted?.unmount();
  mounted = null;
}

/** Type a prompt and press Enter, as the user does. */
export async function send(wrapper: ReturnType<typeof mount>, text: string): Promise<void> {
  const textarea = wrapper.find('textarea');
  await textarea.setValue(text);
  await textarea.trigger('keydown', { key: 'Enter' });
  await settle();
}
