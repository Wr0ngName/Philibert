/**
 * The header's schedules button and the view it opens, through the real
 * stores, preload and conversation IPC: schedules arrive as the main process
 * sends them (claude:session-schedules), shaped as the bundled CLI was
 * measured to list them — a CronCreate job and a ScheduleWakeup wake-up.
 */

import { mount } from '@vue/test-utils';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { IPC_CHANNELS, type Conversation, type SessionSchedule } from '@shared/types';

vi.mock('node:fs', async () => (await import('./support/real-stack')).fakeFsModule());
vi.mock('electron', async () => (await import('./support/real-stack')).fakeElectronModule());
vi.mock('../../../main/utils/paths', () => ({
  getConversationsPath: () => '/conversations',
  isPathWithin: () => true,
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
import SchedulesButton from '../../components/shared/SchedulesButton.vue';
import { useChatStore } from '../chat';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import { startRealStack, settle, files, unmountApp, mountApp, emitIpc } from './support/real-stack';

function stored(id: string, title: string): Conversation {
  return {
    id, title, workingDirectory: '/home/user/project', createdAt: 1, updatedAt: 1,
    messages: [{ id: `${id}-m`, role: 'user', content: title, timestamp: 1 }],
  };
}

/** A one-shot wake-up for `minutes` from now, encoded as the CLI encodes one. */
function wakeUpIn(minutes: number): SessionSchedule {
  const at = new Date(Date.now() + minutes * 60_000);
  return {
    id: 'f37b8a54', schedule: `${at.getMinutes()} ${at.getHours()} * * *`, recurring: false,
    prompt: 'check the build', since: Date.now(),
  };
}

const JOB: SessionSchedule = {
  id: '6cf46d13', schedule: '*/5 * * * *', recurring: true, prompt: 'check the fleet',
  since: Date.now(), humanSchedule: 'Every 5 minutes',
};

describe('the schedules button', () => {
  let button: ReturnType<typeof mount>;

  beforeEach(async () => {
    await startRealStack({
      ConversationService: ConversationService as unknown as new () => never,
      setupConversationIPC: setupConversationIPC as unknown as (service: never) => void,
    });
    files.set('/conversations/conv-fleet.json', JSON.stringify(stored('conv-fleet', 'Fleet coordinator')));
    files.set('/conversations/conv-build.json', JSON.stringify(stored('conv-build', 'Build watcher')));

    const settings = useSettingsStore();
    settings.config.workingDirectory = '/home/user/project';
    settings.config.apiKey = 'test-key';
    const conversations = useConversationsStore();
    await conversations.loadConversationList();
    await conversations.switchConversation('conv-fleet');
    mountApp(ChatWindow);
    button = mount(SchedulesButton, { attachTo: document.body });
    await settle();
  });

  afterEach(() => {
    button.unmount();
    unmountApp();
    document.body.innerHTML = '';
  });

  const rows = () => [...document.body.querySelectorAll<HTMLElement>('.schedule-row')];
  const badge = () => button.find('.schedules-count');

  it('counts nothing and says so when nothing is scheduled', async () => {
    expect(badge().exists()).toBe(false);

    await button.find('.schedules-button').trigger('click');
    await settle();

    expect(document.body.querySelector('.schedules-empty')?.textContent).toContain('Nothing is scheduled.');
  });

  it('lists every discussion\'s schedules, soonest first, with what each will send', async () => {
    emitIpc(IPC_CHANNELS.CLAUDE_SESSION_SCHEDULES, 'conv-build', [wakeUpIn(10)]);
    emitIpc(IPC_CHANNELS.CLAUDE_SESSION_SCHEDULES, 'conv-fleet', [JOB]);
    await settle();
    expect(badge().text()).toBe('2');

    await button.find('.schedules-button').trigger('click');
    await settle();

    // Every 5 minutes comes before a wake-up in 10.
    expect(rows().map((r) => [
      r.dataset.kind,
      r.querySelector('.schedule-discussion')?.textContent?.trim(),
      r.querySelector('.schedule-cadence')?.textContent?.trim(),
      r.querySelector('.schedule-prompt')?.textContent?.trim(),
    ])).toEqual([
      ['recurring', 'Fleet coordinator', 'Every 5 minutes', 'check the fleet'],
      ['once', 'Build watcher', 'Once', 'check the build'],
    ]);
    expect(rows()[1].querySelector('.schedule-when')?.textContent).toMatch(/in (9m|10m)/);
    expect(rows()[0].querySelector('.schedule-details')?.textContent).toContain('*/5 * * * * · id 6cf46d13');
  });

  it("includes a discussion's continue after a usage limit", async () => {
    useChatStore().setUsageLimitWait('conv-build', { resetsAt: Date.now() + 60_000, resumeAt: Date.now() + 90_000 });
    await settle();

    await button.find('.schedules-button').trigger('click');
    await settle();

    expect(rows().map((r) => [r.dataset.kind, r.querySelector('.schedule-discussion')?.textContent?.trim()]))
      .toEqual([['usage-limit', 'Build watcher']]);
  });

  it('opens a discussion from its schedule, and closes', async () => {
    emitIpc(IPC_CHANNELS.CLAUDE_SESSION_SCHEDULES, 'conv-build', [wakeUpIn(10)]);
    await settle();
    await button.find('.schedules-button').trigger('click');
    await settle();

    rows()[0].querySelector<HTMLButtonElement>('.schedule-discussion')!.click();
    await settle(20);

    expect(useConversationsStore().currentConversationId).toBe('conv-build');
    expect(rows()).toEqual([]);
  });

  it('drops what a later list no longer has, and shows a paused job without a time', async () => {
    emitIpc(IPC_CHANNELS.CLAUDE_SESSION_SCHEDULES, 'conv-fleet', [JOB, wakeUpIn(10)]);
    await settle();
    emitIpc(IPC_CHANNELS.CLAUDE_SESSION_SCHEDULES, 'conv-fleet', [{ ...JOB, durable: true, paused: true }]);
    await settle();

    expect(badge().exists()).toBe(false);
    await button.find('.schedules-button').trigger('click');
    await settle();
    expect(rows().map((r) => r.querySelector('.schedule-when')?.textContent?.trim()))
      .toEqual(['Paused — resumes when this discussion runs again']);
  });
});
