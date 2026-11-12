/**
 * A usage limit's wait across the app being closed, through the real path.
 *
 * The wait is the app's own (an SDK session has none), so it only runs while
 * the app does. These tests stop a turn, close the app and start it again on
 * the same disk, and check what the user finds: a continue still to come
 * goes out when due; one that came due while the app was closed is not done
 * behind their back but shown as missed — banner, notification, the
 * discussion marked as waiting on them, listed where they will see it — and
 * archiving gives way to the wait without ever being held off for good.
 *
 * Real ChatWindow, real stores, real preload, real conversation IPC handlers
 * and the real ConversationService, started afresh at each launch; only
 * Electron and the filesystem are faked, and the clock.
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

import { DAY_MS } from '@shared/conversation-list';

import { setupConversationIPC } from '../../../main/ipc/conversations';
import { ConversationService } from '../../../main/services/ConversationService';
import '../../../preload/preload';
import ChatWindow from '../../components/chat/ChatWindow.vue';
import { CONSTANTS } from '../../constants/app';
import { USAGE_LIMIT_CHECK_INTERVAL_MS, USAGE_LIMIT_CONTINUE_PROMPT, formatResetTime } from '../../utils/usage-limit';
import { useChatStore } from '../chat';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import {
  startRealStack, settle, emitIpc, mainHandlers, mountApp, unmountApp, send, onDisk,
  sessionOnDisk, restartApp, missedContinuesNotified, setStoredConfig, storedConfig, disk, releaseWrites,
} from './support/real-stack';

const NOW = new Date(2026, 9, 26, 14, 0).getTime();
const HOUR = 60 * 60 * 1000;
const REFUSAL = "You've hit your limit · resets 3pm";

describe('a usage limit waited on across a restart', () => {
  let store: ReturnType<typeof useConversationsStore>;
  let chat: ReturnType<typeof useChatStore>;
  let app: ReturnType<typeof mount>;
  /** What reached the main process's send handler: [conversationId, prompt]. */
  let sends: [string, string][];

  function recordSends(): void {
    mainHandlers.set('claude:send', (_event, conversationId, prompt) => {
      sends.push([conversationId as string, prompt as string]);
    });
    // Its session is on disk: the discussion can be continued.
    mainHandlers.set('claude:session-exists', () => true);
  }

  /** The app starting: stores, the list and the waits read back, the window. */
  async function launch(): Promise<void> {
    store = useConversationsStore();
    chat = useChatStore();
    const settings = useSettingsStore();
    settings.config = { ...settings.config, ...storedConfig } as typeof settings.config;
    await store.initialize();
    await settle(20);
    app = mountApp(ChatWindow);
    await settle(20);
  }

  /** Closed, and started again at `at`. */
  async function relaunchAt(at: number): Promise<void> {
    restartApp();
    // What this run of the app sends.
    sends = [];
    recordSends();
    vi.setSystemTime(at);
    await launch();
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    await startRealStack({
      ConversationService: ConversationService as unknown as new () => never,
      setupConversationIPC: setupConversationIPC as unknown as (service: never) => void,
    });
    sends = [];
    recordSends();
    setStoredConfig({ ...storedConfig, autoArchiveDays: 7, usageLimitWaitDays: 7 });
    await launch();
  });

  afterEach(() => {
    unmountApp();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  /** A discussion with its own session, whose turn a usage limit stopped, the turn over. */
  async function stoppedConversation(resetsAt = NOW + HOUR, prompt = 'build the feature'): Promise<string> {
    store.createNewConversation();
    const id = store.currentConversationId!;
    await send(app, prompt);
    sessionOnDisk(`session-${id}`);
    emitIpc('claude:session-id', id, `session-${id}`);
    emitIpc('claude:chunk', id, REFUSAL);
    emitIpc('claude:usage-limit', id, { resetsAt, limitType: 'five_hour' });
    emitIpc('claude:done', id);
    await settle(30);
    return id;
  }

  /** Move the clock to `at` and let the wait check run. */
  async function clockTo(at: number): Promise<void> {
    vi.setSystemTime(at);
    vi.advanceTimersByTime(USAGE_LIMIT_CHECK_INTERVAL_MS);
    await settle(30);
  }

  function resumeAt(id: string): number {
    const at = chat.getConversationState(id).usageLimitWait?.resumeAt;
    expect(at, 'expected a scheduled continue').toBeTypeOf('number');
    return at as number;
  }

  function button(label: string) {
    const found = app.findAll('button').find((b) => b.text() === label);
    expect(found, `expected a "${label}" button`).toBeDefined();
    return found!;
  }

  it('saves the wait with the discussion, and forgets it once the task continued', async () => {
    const id = await stoppedConversation();
    const at = resumeAt(id);
    expect(onDisk(id)?.usageLimitWait).toMatchObject({ resetsAt: NOW + HOUR, resumeAt: at, limitType: 'five_hour' });

    await clockTo(at);
    expect(sends.at(-1)).toEqual([id, USAGE_LIMIT_CONTINUE_PROMPT]);
    await settle(20);
    expect(onDisk(id)?.usageLimitWait).toBeUndefined();
  });

  it('continues after a restart when the continue is still to come', async () => {
    const id = await stoppedConversation();
    const at = resumeAt(id);

    await relaunchAt(NOW + HOUR / 2);
    await store.switchConversation(id);
    await settle(20);
    expect(app.text()).toContain('Usage limit reached · continuing automatically at');
    expect(missedContinuesNotified).toEqual([]);

    await clockTo(at);
    expect(sends).toEqual([[id, USAGE_LIMIT_CONTINUE_PROMPT]]);
  });

  describe('a continue that came due while the app was closed', () => {
    let id: string;

    beforeEach(async () => {
      id = await stoppedConversation();
      await relaunchAt(NOW + 2 * HOUR);
      await store.switchConversation(id);
      await settle(20);
    });

    it('is not done, and the user is told it waits on them', async () => {
      expect(sends).toEqual([]);
      expect(app.text()).toContain(
        `Not continued: Philibert was closed when the limit reset at ${formatResetTime(NOW + HOUR, NOW + 2 * HOUR)}`,
      );
      expect(missedContinuesNotified).toEqual([[id]]);
      // What flashes the window and marks it in the list.
      expect(chat.anyConversationAwaitsUser).toBe(true);
      expect(chat.conversationAwaitsUser(id)).toBe(true);
      expect(onDisk(id)?.usageLimitWait).toEqual({
        resetsAt: NOW + HOUR, resumeAt: null, limitType: 'five_hour', missedAt: NOW + 2 * HOUR,
      });

      // The clock going on does not continue it.
      await clockTo(NOW + 3 * HOUR);
      expect(sends).toEqual([]);
    });

    it('is told once: the next start finds it missed already, still waiting on the user', async () => {
      await relaunchAt(NOW + 3 * HOUR);
      // Only the first start's notification.
      expect(missedContinuesNotified).toEqual([[id]]);
      expect(chat.conversationAwaitsUser(id)).toBe(true);
    });

    it('continues when the user asks, and waits on them no longer', async () => {
      await button('Continue now').trigger('click');
      await settle(30);

      expect(sends).toEqual([[id, USAGE_LIMIT_CONTINUE_PROMPT]]);
      expect(chat.anyConversationAwaitsUser).toBe(false);
      expect(onDisk(id)?.usageLimitWait).toBeUndefined();
    });

    it('goes when the user dismisses it', async () => {
      await button('Dismiss').trigger('click');
      await settle(20);

      expect(chat.anyConversationAwaitsUser).toBe(false);
      expect(app.text()).not.toContain('Usage limit');
      expect(onDisk(id)?.usageLimitWait).toBeUndefined();
      await clockTo(NOW + DAY_MS);
      expect(sends).toEqual([]);
    });

    describe('dismissed while its save is still on its way', () => {
      beforeEach(async () => {
        disk.holdWrites = true;
        await button('Dismiss').trigger('click');
        await settle(20);
        // The disk still says it waits.
        expect(onDisk(id)?.usageLimitWait?.missedAt).toBe(NOW + 2 * HOUR);
      });

      afterEach(async () => {
        await releaseWrites();
      });

      it('stays dismissed when the list is read again meanwhile', async () => {
        await store.loadConversationList();
        await settle(20);
        expect(store.conversations.find((c) => c.id === id)?.usageLimitWait).toBeUndefined();
      });

      it('stays dismissed when the discussion is read again meanwhile', async () => {
        await store.loadConversation(id);
        await settle(20);
        expect(store.conversations.find((c) => c.id === id)?.usageLimitWait).toBeUndefined();
      });
    });

    it('keeps the discussion out of the archive for the archive delay from then, and no longer', async () => {
      const toldAt = NOW + 2 * HOUR;
      await clockTo(toldAt + 7 * DAY_MS - HOUR);
      expect(store.isConversationArchived(id)).toBe(false);
      expect(chat.conversationAwaitsUser(id)).toBe(true);

      await clockTo(toldAt + 7 * DAY_MS + HOUR);
      expect(store.isConversationArchived(id)).toBe(true);
      // Archived: nothing calls the user to it any more, on screen or on disk.
      expect(chat.anyConversationAwaitsUser).toBe(false);
      expect(onDisk(id)?.usageLimitWait).toBeUndefined();
      expect(sends).toEqual([]);
    });
  });

  it('archives one inactive for longer once its missed continue is dismissed, and counts it', async () => {
    const id = await stoppedConversation();
    // Closed for over a week: inactive past the archive delay, kept in view by the wait.
    await relaunchAt(NOW + 8 * DAY_MS);
    await store.switchConversation(id);
    await settle(20);
    expect(store.isConversationArchived(id)).toBe(false);
    const before = store.archivedCount;

    disk.holdWrites = true;
    await button('Dismiss').trigger('click');
    await settle(20);
    expect(store.isConversationArchived(id)).toBe(true);

    await releaseWrites();
    await settle(20);
    expect(store.archivedCount).toBe(before + 1);
  });

  it('lists a discussion missed while closed though its page is not loaded', async () => {
    const id = await stoppedConversation();
    // A full page of newer discussions above it.
    for (let i = 0; i < CONSTANTS.CONVERSATION.LIST_PAGE_SIZE; i += 1) {
      vi.setSystemTime(NOW + (i + 1) * 1000);
      store.createNewConversation();
      const newer = store.currentConversationId!;
      await send(app, `newer ${i}`);
      sessionOnDisk(`session-${newer}`);
      emitIpc('claude:session-id', newer, `session-${newer}`);
      emitIpc('claude:done', newer);
      await settle(10);
    }

    await relaunchAt(NOW + 2 * HOUR);

    expect(store.listedConversations.map((c) => c.id)).toContain(id);
    expect(chat.conversationAwaitsUser(id)).toBe(true);
  });

  it('continues before archiving when the wait is as long as the archive delay', async () => {
    // Archiving after a week, waiting up to a week, for a reset a week out.
    const id = await stoppedConversation(NOW + 7 * DAY_MS);
    const at = resumeAt(id);

    await clockTo(at - HOUR);
    expect(store.isConversationArchived(id)).toBe(false);
    await clockTo(at);
    expect(sends.at(-1)).toEqual([id, USAGE_LIMIT_CONTINUE_PROMPT]);
    expect(store.isConversationArchived(id)).toBe(false);
  });

  it('drops the wait of a discussion archived by hand, so a restart finds none', async () => {
    const id = await stoppedConversation();
    expect(await store.setConversationArchived(id, true)).toBe(true);
    await settle(20);
    expect(onDisk(id)?.usageLimitWait).toBeUndefined();

    await relaunchAt(NOW + 2 * HOUR);
    expect(missedContinuesNotified).toEqual([]);
    expect(chat.anyConversationAwaitsUser).toBe(false);
  });

  it('unschedules, on disk too, a continue too far out once the setting waits less', async () => {
    const id = await stoppedConversation(NOW + 3 * DAY_MS);
    resumeAt(id);

    useSettingsStore().config.usageLimitWaitDays = 2;
    await settle(20);

    expect(chat.getConversationState(id).usageLimitWait?.resumeAt).toBeNull();
    expect(onDisk(id)?.usageLimitWait?.resumeAt).toBeNull();
    await clockTo(NOW + 3 * DAY_MS + HOUR);
    expect(sends.filter(([, prompt]) => prompt === USAGE_LIMIT_CONTINUE_PROMPT)).toEqual([]);
  });
});
