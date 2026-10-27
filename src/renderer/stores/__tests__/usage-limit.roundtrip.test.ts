/**
 * Waiting out a usage limit, through the real path.
 *
 * Interactive Claude Code shows "Usage limit reached · continuing
 * automatically at 7:50pm · esc to cancel" and carries the task on after the
 * reset. In an SDK session that wait does not exist, so the app does it: these
 * tests stop a turn the way the main process reports it, let the clock pass
 * the reset, and check that the continue goes out — to the right
 * conversation, into the right transcript, and onto disk.
 *
 * Real ChatWindow, real stores, real preload, real conversation IPC handlers
 * and the real ConversationService; only Electron and the filesystem are
 * faked, and the clock.
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
import UsageWarningBanner from '../../components/shared/UsageWarningBanner.vue';
import { USAGE_LIMIT_CHECK_INTERVAL_MS, USAGE_LIMIT_CONTINUE_PROMPT } from '../../utils/usage-limit';
import { useChatStore } from '../chat';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import {
  startRealStack, settle, diskContents, emitIpc, mainHandlers, mountApp, unmountApp, send,
} from './support/real-stack';

const NOW = new Date(2026, 9, 26, 14, 0).getTime();
const HOUR = 60 * 60 * 1000;
const REFUSAL = "You've hit your limit · resets 3pm";

describe('a task stopped by a usage limit', () => {
  let store: ReturnType<typeof useConversationsStore>;
  let chat: ReturnType<typeof useChatStore>;
  let settings: ReturnType<typeof useSettingsStore>;
  let app: ReturnType<typeof mount>;
  /** What reached the main process's send handler: [conversationId, prompt]. */
  let sends: [string, string][];

  beforeEach(async () => {
    // Only the clock and the intervals: settle() runs on promises and ticks.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);

    await startRealStack({
      ConversationService: ConversationService as unknown as new () => never,
      setupConversationIPC: setupConversationIPC as unknown as (service: never) => void,
    });
    sends = [];
    mainHandlers.set('claude:send', (_event, conversationId, prompt) => {
      sends.push([conversationId as string, prompt as string]);
    });

    store = useConversationsStore();
    chat = useChatStore();
    settings = useSettingsStore();
    settings.config.workingDirectory = '/home/user/project';
    settings.config.apiKey = 'test-key';
    await store.loadConversationList();
    await settle();
    app = mountApp(ChatWindow);
    await settle();
  });

  afterEach(() => {
    unmountApp();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  /** A conversation whose turn the usage limit stopped, with the turn over. */
  async function stoppedConversation(prompt = 'build the feature'): Promise<string> {
    store.createNewConversation();
    const id = store.currentConversationId!;
    await send(app, prompt);
    emitIpc('claude:chunk', id, REFUSAL);
    emitIpc('claude:usage-limit', id, { resetsAt: NOW + HOUR, limitType: 'five_hour' });
    emitIpc('claude:done', id);
    await settle(20);
    return id;
  }

  /** Move the clock to `at` and let the due check run. */
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

  it('says it will continue, and continues once the limit resets', async () => {
    const id = await stoppedConversation();
    expect(app.text()).toContain('Usage limit reached · continuing automatically at');

    // Not before the reset: that would only hit the limit again.
    await clockTo(NOW + HOUR - 1000);
    expect(sends).toHaveLength(1);

    await clockTo(resumeAt(id));
    expect(sends).toEqual([[id, 'build the feature'], [id, USAGE_LIMIT_CONTINUE_PROMPT]]);
    expect(chat.messages.at(-2)?.content).toBe(USAGE_LIMIT_CONTINUE_PROMPT);
    expect(app.text()).not.toContain('Usage limit');

    emitIpc('claude:chunk', id, 'carried on');
    emitIpc('claude:done', id);
    await settle(20);
    expect(diskContents(id)).toEqual(['build the feature', REFUSAL, USAGE_LIMIT_CONTINUE_PROMPT, 'carried on']);
  });

  it('continues a conversation the user has left, in that conversation', async () => {
    const stopped = await stoppedConversation();
    const at = resumeAt(stopped);

    // Somewhere else entirely by the time the limit resets.
    store.createNewConversation();
    const elsewhere = store.currentConversationId!;
    await send(app, 'an unrelated question');
    emitIpc('claude:chunk', elsewhere, 'an unrelated answer');
    emitIpc('claude:done', elsewhere);
    await settle(20);

    await clockTo(at);
    expect(sends.at(-1)).toEqual([stopped, USAGE_LIMIT_CONTINUE_PROMPT]);
    // Nothing of it in the conversation on screen.
    expect(chat.messages.map((m) => m.content)).toEqual(['an unrelated question', 'an unrelated answer']);

    emitIpc('claude:chunk', stopped, 'carried on');
    emitIpc('claude:done', stopped);
    await settle(20);
    expect(diskContents(stopped)).toEqual(['build the feature', REFUSAL, USAGE_LIMIT_CONTINUE_PROMPT, 'carried on']);

    await store.switchConversation(stopped);
    await settle(20);
    expect(chat.messages.map((m) => m.content)).toEqual(
      ['build the feature', REFUSAL, USAGE_LIMIT_CONTINUE_PROMPT, 'carried on'],
    );
  });

  it('holds queued prompts until the task has continued', async () => {
    store.createNewConversation();
    const id = store.currentConversationId!;
    await send(app, 'build the feature');
    chat.queuePrompt(id, 'then write the docs');
    emitIpc('claude:chunk', id, REFUSAL);
    emitIpc('claude:usage-limit', id, { resetsAt: NOW + HOUR });
    emitIpc('claude:done', id);
    await settle(20);

    // Sent now, it would only hit the same limit.
    expect(sends).toHaveLength(1);

    await clockTo(resumeAt(id));
    emitIpc('claude:chunk', id, 'carried on');
    emitIpc('claude:done', id);
    await settle(20);

    expect(sends.map(([, prompt]) => prompt)).toEqual(
      ['build the feature', USAGE_LIMIT_CONTINUE_PROMPT, 'then write the docs'],
    );
  });

  it('does not continue after the user cancels, and offers the wait again', async () => {
    const id = await stoppedConversation();
    const at = resumeAt(id);

    await button('Cancel').trigger('click');
    await settle();
    expect(app.text()).toContain('Usage limit reached · resets at');

    await clockTo(at + HOUR);
    expect(sends).toHaveLength(1);
  });

  it('offers the wait instead when automatic continue is off, and waits when asked', async () => {
    settings.config.autoContinueAtUsageLimit = false;
    const id = await stoppedConversation();
    expect(app.text()).toContain('Usage limit reached · resets at');

    await clockTo(NOW + HOUR / 2);
    expect(sends).toHaveLength(1);

    await button('Continue automatically').trigger('click');
    await settle();
    await clockTo(resumeAt(id));
    expect(sends.at(-1)).toEqual([id, USAGE_LIMIT_CONTINUE_PROMPT]);
  });

  it('continues at once when the user asks', async () => {
    const id = await stoppedConversation();

    await button('Continue now').trigger('click');
    await settle(30);

    expect(sends.at(-1)).toEqual([id, USAGE_LIMIT_CONTINUE_PROMPT]);
  });

  it('stops waiting once the user sends something themselves', async () => {
    const id = await stoppedConversation();
    const at = resumeAt(id);

    await send(app, 'never mind, do something else');
    expect(chat.getConversationState(id).usageLimitWait).toBeNull();

    emitIpc('claude:done', id);
    await settle(20);
    await clockTo(at);
    expect(sends.map(([, prompt]) => prompt)).toEqual(['build the feature', 'never mind, do something else']);
  });

  it('unschedules waiting tasks when automatic continue is turned off', async () => {
    const id = await stoppedConversation();
    const at = resumeAt(id);

    settings.config.autoContinueAtUsageLimit = false;
    await settle();

    await clockTo(at);
    expect(sends).toHaveLength(1);
    expect(chat.getConversationState(id).usageLimitWait?.resumeAt).toBeNull();
  });

  describe('a usage limit getting close', () => {
    // What a real session reported (main.log, 2026-10-27): the weekly limit
    // past 75%, creeping to 80%, resetting days later.
    const RESETS_AT = NOW + 3 * 24 * HOUR;
    const warning = (utilization: number) => ({
      utilization, limitType: 'seven_day', resetsAt: RESETS_AT, surpassedThreshold: 0.75,
    });
    let banner: ReturnType<typeof mount>;

    beforeEach(() => {
      banner = mount(UsageWarningBanner);
    });

    afterEach(() => banner.unmount());

    it('says so, as the CLI does, and follows the usage as it grows', async () => {
      expect(banner.text()).toBe('');

      emitIpc('claude:usage-warning', warning(0.75));
      await settle();
      expect(banner.text()).toContain("You've used 75% of your weekly limit · resets");

      emitIpc('claude:usage-warning', warning(0.8));
      await settle();
      expect(banner.text()).toContain("You've used 80% of your weekly limit");
    });

    it('stays dismissed until the server warns about something new', async () => {
      emitIpc('claude:usage-warning', warning(0.75));
      await settle();
      await banner.findAll('button').find((b) => b.text() === 'Dismiss')!.trigger('click');
      await settle();
      expect(banner.text()).toBe('');

      emitIpc('claude:usage-warning', warning(0.8));
      await settle();
      expect(banner.text()).toBe('');

      emitIpc('claude:usage-warning', { ...warning(0.9), surpassedThreshold: 0.9 });
      await settle();
      expect(banner.text()).toContain("You've used 90% of your weekly limit");
    });

    it('goes when usage is back under the threshold, or the limit resets', async () => {
      emitIpc('claude:usage-warning', warning(0.8));
      await settle();
      expect(banner.text()).toContain('80%');
      emitIpc('claude:usage-warning', null);
      await settle();
      expect(banner.text()).toBe('');

      emitIpc('claude:usage-warning', warning(0.8));
      await settle();
      expect(banner.text()).toContain('80%');
      vi.setSystemTime(RESETS_AT);
      vi.advanceTimersByTime(1000);
      await settle();
      expect(banner.text()).toBe('');
    });
  });
});
