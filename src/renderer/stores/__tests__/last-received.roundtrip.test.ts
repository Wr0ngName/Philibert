/**
 * The line ending a discussion with when Claude was last heard from.
 *
 * Asked for as Claude Code's end-of-turn "done 6:58 PM": the time something
 * last arrived, not a history — so one line, at the end, on the right and
 * outside the bubbles so it is never read as part of the answer. These check
 * what the user sees through the real path: events from the main process,
 * the real window and stores, the real conversation IPC and
 * ConversationService, and a restart on the same disk.
 *
 * Only Electron and the filesystem are faked, and the clock.
 */

import { mount } from '@vue/test-utils';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('node:fs', async () => (await import('./support/real-stack')).fakeFsModule());
vi.mock('electron', async () => (await import('./support/real-stack')).fakeElectronModule());
vi.mock('../../../main/utils/paths', () => ({
  getConversationsPath: () => '/conversations',
  isPathWithin: (target: string, root: string) => target.startsWith(root),
}));
vi.mock('../../../main/utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogLevel: vi.fn(),
}));
vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { setupConversationIPC } from '../../../main/ipc/conversations';
import { ConversationService } from '../../../main/services/ConversationService';
import '../../../preload/preload';
import ChatWindow from '../../components/chat/ChatWindow.vue';
import { lastReceivedLine } from '../../utils/last-received';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import {
  startRealStack, settle, emitIpc, mainHandlers, mountApp, unmountApp, send, onDisk, restartApp,
} from './support/real-stack';

const NOW = new Date(2026, 10, 12, 18, 0).getTime();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe('when Claude was last heard from, at the end of the discussion', () => {
  let store: ReturnType<typeof useConversationsStore>;
  let app: ReturnType<typeof mount>;

  async function launch(): Promise<void> {
    mainHandlers.set('claude:send', () => undefined);
    store = useConversationsStore();
    // What a send needs before it goes: somewhere to run, and a key.
    const settings = useSettingsStore();
    settings.config.workingDirectory = '/home/user/project';
    settings.config.apiKey = 'test-key';
    await store.initialize();
    await settle(20);
    app = mountApp(ChatWindow);
    await settle(20);
  }

  /** The line, or null when the list does not end with one. */
  function line(): string | null {
    const rows = app.findAll('.chat-row');
    const last = rows.at(-1);
    const found = last?.find('.last-received');
    return found?.exists() ? found.text() : null;
  }

  /** Move the clock to `at` — what the next event arrives at. */
  function at(time: number): void {
    vi.setSystemTime(time);
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    await startRealStack({
      ConversationService: ConversationService as unknown as new () => never,
      setupConversationIPC: setupConversationIPC as unknown as (service: never) => void,
    });
    await launch();
  });

  afterEach(() => {
    unmountApp();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  /** A discussion whose turn streamed until `last`, then ended at `done`. */
  async function answered(last: number, done: number): Promise<string> {
    store.createNewConversation();
    const id = store.currentConversationId!;
    await send(app, 'build the feature');
    at(last - MINUTE);
    emitIpc('claude:chunk', id, 'Working on it. ');
    at(last);
    emitIpc('claude:chunk', id, 'Done.');
    await settle(10);
    expect(line(), 'said while Claude is still answering').toBeNull();
    at(done);
    emitIpc('claude:done', id);
    await settle(30);
    return id;
  }

  it('says nothing in a discussion nothing has arrived in yet', async () => {
    store.createNewConversation();
    await settle(10);
    expect(line()).toBeNull();
  });

  it('says when the turn ended, once it has, and saves it', async () => {
    const id = await answered(NOW + MINUTE, NOW + 2 * MINUTE);

    expect(line()).toBe(lastReceivedLine(NOW + 2 * MINUTE, NOW + 2 * MINUTE, 0));
    expect(onDisk(id)?.lastReceivedAt).toBe(NOW + 2 * MINUTE);
  });

  it('is on the right and outside every bubble', async () => {
    await answered(NOW + MINUTE, NOW + MINUTE);

    const row = app.findAll('.chat-row').at(-1)!;
    const text = row.find('.last-received');
    expect(text.classes()).toContain('text-right');
    // Not a slice of the turn's bubble, which would draw it inside the answer.
    expect(row.find('.turn-slice').exists()).toBe(false);
    expect(row.find('.message-bubble').exists()).toBe(false);
  });

  it('is hidden again while the next turn runs', async () => {
    const id = await answered(NOW + MINUTE, NOW + MINUTE);
    await send(app, 'and the tests');
    emitIpc('claude:chunk', id, 'Writing them.');
    await settle(10);
    expect(line()).toBeNull();
  });

  it('moves on when something arrives after the turn: a background task reporting back', async () => {
    const id = await answered(NOW + MINUTE, NOW + MINUTE);
    at(NOW + 20 * MINUTE);
    emitIpc('claude:task-notification', id, { taskId: 'task-1', status: 'completed', description: 'Run the build' });
    await settle(20);
    expect(line()).toBe(lastReceivedLine(NOW + 20 * MINUTE, NOW + 20 * MINUTE, 0));
  });

  // Everything else Claude can send with no turn running. Each moves the line,
  // so whichever arrived last is the one it says.
  const LATE: Array<[string, (id: string) => void]> = [
    ['text', (id) => emitIpc('claude:chunk', id, 'One more thing.')],
    ['a tool call', (id) => emitIpc('claude:tool-capture', id, {
      toolUseBlockId: 'toolu_late', toolName: 'Read', input: { file_path: '/a' }, description: 'Read /a',
    })],
    ['a tool result', (id) => emitIpc('claude:tool-result', id, { toolUseBlockId: 'toolu_late', outputFile: '/tmp/out' })],
    ['a permission request', (id) => emitIpc('claude:tool-use', id, {
      id: 'action-late', type: 'generic-tool', toolName: 'WebFetch', description: 'Fetch a page',
      input: {}, status: 'pending', timestamp: NOW,
      details: { rawInput: {}, secondaryFields: [], jsonFields: [] },
    })],
    ['a note', (id) => emitIpc('claude:system-note', id, 'Conversation compacted')],
    ['an error', (id) => emitIpc('claude:error', id, 'Connection lost')],
  ];

  it.each(LATE)('moves on for %s arriving after the turn', async (_what, arrive) => {
    const id = await answered(NOW + MINUTE, NOW + MINUTE);
    at(NOW + 7 * MINUTE);
    arrive(id);
    await settle(20);
    expect(line()).toBe(lastReceivedLine(NOW + 7 * MINUTE, NOW + 7 * MINUTE, 0));
  });

  it('says how many background tasks are still running, until they are not', async () => {
    const id = await answered(NOW + MINUTE, NOW + MINUTE);
    at(NOW + 2 * MINUTE);
    emitIpc('claude:task-notification', id, { taskId: 'task-1', status: 'running', description: 'Run the build' });
    emitIpc('claude:task-notification', id, { taskId: 'task-2', status: 'running', description: 'Run the tests' });
    await settle(20);
    expect(line()).toBe(`${lastReceivedLine(NOW + 2 * MINUTE, NOW + 2 * MINUTE, 0)} · 2 background tasks still running`);

    at(NOW + 3 * MINUTE);
    emitIpc('claude:task-notification', id, { taskId: 'task-1', status: 'completed' });
    await settle(20);
    expect(line()).toBe(`${lastReceivedLine(NOW + 3 * MINUTE, NOW + 3 * MINUTE, 0)} · 1 background task still running`);
  });

  it('still says when Claude was last heard from after a restart — with the date on another day', async () => {
    const id = await answered(NOW + MINUTE, NOW + 2 * MINUTE);

    restartApp();
    const nextDay = NOW + 20 * HOUR;
    at(nextDay);
    await launch();
    await store.switchConversation(id);
    await settle(20);

    // The time it last heard from Claude, not the time it was opened.
    expect(line()).toBe(lastReceivedLine(NOW + 2 * MINUTE, nextDay, 0));
    expect(line()).not.toBe(lastReceivedLine(NOW + 2 * MINUTE, NOW + 2 * MINUTE, 0));
  });

  it('keeps the saved time when the discussion is saved again with nothing new from Claude', async () => {
    const id = await answered(NOW + MINUTE, NOW + 2 * MINUTE);

    restartApp();
    at(NOW + HOUR);
    await launch();
    // Saved by this run before it opened the discussion: it has heard
    // nothing from Claude in it, which is not "never heard from".
    const saved = await store.saveConversation(id, [
      { id: 'msg-note', role: 'user', content: 'a note', timestamp: NOW + HOUR },
    ]);
    expect(saved).toBe(true);
    expect(onDisk(id)?.lastReceivedAt).toBe(NOW + 2 * MINUTE);
  });
});
