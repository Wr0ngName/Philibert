/**
 * The discussions list as the user meets it: scrolled to its end, it shows
 * the next page; a discussion archived from it moves to the Archived tab and
 * is brought back from there.
 *
 * Real list component, real stores, real preload, real IPC handlers and the
 * real ConversationService; only Electron, the filesystem and the browser's
 * IntersectionObserver are faked — the last because happy-dom lays nothing
 * out, so nothing would ever come into view.
 */

import { mount } from '@vue/test-utils';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { Conversation } from '@shared/types';

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
import ConversationSearch from '../../components/chat/ConversationSearch.vue';
import ConversationHistory from '../../components/conversations/ConversationHistory.vue';
import { useChatStore } from '../chat';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import { startRealStack, settle, files, unmountApp } from './support/real-stack';

/** The observers the list made, so a test can bring its end marker into view. */
const observers: FakeObserver[] = [];

class FakeObserver {
  observed: Element[] = [];
  disconnected = false;
  constructor(private readonly callback: IntersectionObserverCallback) {
    observers.push(this);
  }
  observe(target: Element) {
    this.observed.push(target);
  }
  disconnect() {
    this.disconnected = true;
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
  /** The marker comes within reach, as scrolling to the end does. */
  reach() {
    this.callback(
      this.observed.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    );
  }
}

function seedMany(count: number): string[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const id = `conv_${String(i).padStart(3, '0')}`;
    // Renamed: a title other than its first message, which the search finds.
    const conversation: Conversation = {
      id,
      title: `Discussion ${i}`,
      customTitle: true,
      workingDirectory: '/home/user/project',
      messages: [{ id: `${id}-m`, role: 'user', content: `needle number ${i} here`, timestamp: now - i * 60_000 }],
      createdAt: now - i * 60_000,
      updatedAt: now - i * 60_000,
    };
    files.set(`/conversations/${id}.json`, JSON.stringify(conversation));
    return id;
  });
}

describe('the discussions list', () => {
  let history: ReturnType<typeof mount> | null = null;

  beforeEach(async () => {
    observers.length = 0;
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    await startRealStack({
      ConversationService: ConversationService as unknown as new () => never,
      setupConversationIPC: setupConversationIPC as unknown as (service: never) => void,
    });
    const settings = useSettingsStore();
    settings.config.workingDirectory = '/home/user/project';
    settings.config.apiKey = 'test-key';
  });

  afterEach(() => {
    history?.unmount();
    history = null;
    unmountApp();
    vi.unstubAllGlobals();
  });

  async function open(): Promise<ReturnType<typeof mount>> {
    await useConversationsStore().loadConversationList();
    history = mount(ConversationHistory);
    await settle();
    return history;
  }

  const rows = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('.group');
  const activeObserver = () => observers.filter((o) => !o.disconnected).at(-1);

  it('shows the next page when scrolled to its end, and stops at the last', async () => {
    seedMany(120);
    const wrapper = await open();
    expect(rows(wrapper)).toHaveLength(50);

    activeObserver()!.reach();
    await settle();
    expect(rows(wrapper)).toHaveLength(100);
    // Watched afresh after each page: an observer reports only a change, so
    // a page too short to push the marker out of reach would otherwise be
    // the last one asked for.
    expect(observers).toHaveLength(2);
    expect(observers[0].disconnected).toBe(true);

    activeObserver()!.reach();
    await settle();
    expect(rows(wrapper)).toHaveLength(120);
    expect(wrapper.find('[data-testid="list-end-marker"]').exists()).toBe(false);
    expect(activeObserver()).toBeUndefined();
  });

  describe('opening a search hit in another discussion', () => {
    let search: ReturnType<typeof mount> | null = null;
    let scrolledTo: string[] = [];

    beforeEach(() => {
      scrolledTo = [];
      // happy-dom lays nothing out; what matters is which row was asked to be shown.
      vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) {
        if (this.dataset.conversationId) scrolledTo.push(this.dataset.conversationId);
      });
    });

    afterEach(() => {
      search?.unmount();
      search = null;
      vi.restoreAllMocks();
    });

    /** Search every discussion for the text and open the one hit, as the user does. */
    async function openHit(text: string): Promise<void> {
      search = mount(ConversationSearch, { props: { open: true }, attachTo: document.body });
      await settle();
      const all = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'All discussions');
      all!.click();
      const input = document.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')!;
      input.value = text;
      input.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 260));
      await settle();
      const hits = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].filter((b) =>
        b.textContent?.includes(text));
      expect(hits, `one hit for "${text}"`).toHaveLength(1);
      hits[0].click();
      await settle(20);
    }

    const selectedTab = (wrapper: ReturnType<typeof mount>) =>
      wrapper.findAll('[role="tab"]').find((t) => t.attributes('aria-selected') === 'true')!.text();
    const highlighted = (wrapper: ReturnType<typeof mount>) =>
      wrapper.findAll('.group').filter((r) => r.find('button.bg-primary-50').exists()).map((r) => r.attributes('data-conversation-id'));

    it('lists and shows the discussion opened when its page was not loaded yet', async () => {
      seedMany(120);
      const wrapper = await open();
      expect(rows(wrapper)).toHaveLength(50);

      await openHit('needle number 110 here');

      const store = useConversationsStore();
      expect(store.currentConversationId).toBe('conv_110');
      // Its pages loaded down to it, so it sits among the others.
      expect(rows(wrapper)).toHaveLength(120);
      expect(rows(wrapper)[110].attributes('data-conversation-id')).toBe('conv_110');
      expect(selectedTab(wrapper)).toBe('Active');
      expect(highlighted(wrapper)).toEqual(['conv_110']);
      expect(scrolledTo.at(-1)).toBe('conv_110');
    });

    it('turns to the Archived tab for an archived discussion, and back for an active one', async () => {
      seedMany(3);
      const wrapper = await open();
      const store = useConversationsStore();
      await store.setConversationArchived('conv_002', true);
      await settle();

      await openHit('needle number 2 here');
      expect(store.currentConversationId).toBe('conv_002');
      expect(selectedTab(wrapper)).toBe('Archived (1)');
      expect(highlighted(wrapper)).toEqual(['conv_002']);
      expect(scrolledTo.at(-1)).toBe('conv_002');

      search!.unmount();
      await openHit('needle number 1 here');
      expect(store.currentConversationId).toBe('conv_001');
      expect(selectedTab(wrapper)).toBe('Active');
      expect(highlighted(wrapper)).toEqual(['conv_001']);
    });
  });

  it('archives a discussion from its row, and brings it back from the Archived tab', async () => {
    seedMany(3);
    const wrapper = await open();
    const tab = (name: string) => wrapper.findAll('[role="tab"]').find((t) => t.text().startsWith(name))!;
    expect(tab('Archived').text()).toBe('Archived');

    const row = rows(wrapper).find((r) => r.text().includes('Discussion 1'))!;
    await row.find('button[title="Archive conversation"]').trigger('click');
    await settle();

    expect(rows(wrapper).map((r) => r.text())).not.toContain(expect.stringContaining('Discussion 1'));
    expect(rows(wrapper)).toHaveLength(2);
    expect(tab('Archived').text()).toBe('Archived (1)');

    await tab('Archived').trigger('click');
    await settle();
    expect(tab('Archived').attributes('aria-selected')).toBe('true');
    expect(rows(wrapper)).toHaveLength(1);
    expect(rows(wrapper)[0].text()).toContain('Discussion 1');

    await rows(wrapper)[0].find('button[title="Bring back from the archive"]').trigger('click');
    await settle();
    expect(rows(wrapper)).toHaveLength(0);
    expect(wrapper.text()).toContain('No archived discussions');

    await tab('Active').trigger('click');
    await settle();
    expect(rows(wrapper)).toHaveLength(3);
    expect(tab('Archived').text()).toBe('Archived');
  });

  describe('a discussion just started', () => {
    const newRow = (wrapper: ReturnType<typeof mount>) => wrapper.find('.new-discussion-row');
    const highlighted = (wrapper: ReturnType<typeof mount>) =>
      wrapper.findAll('.group').filter((r) => r.find('button.bg-primary-50').exists()).map((r) => r.attributes('data-conversation-id'));
    const startNew = async (wrapper: ReturnType<typeof mount>) => {
      await wrapper.find('button[title="New conversation"]').trigger('click');
      await settle();
    };
    const savedIds = () => [...files.keys()].filter((f) => f.startsWith('/conversations/')).sort();

    it('is listed, open, before anything is typed, and the one it left is not', async () => {
      seedMany(3);
      const wrapper = await open();
      await rows(wrapper).find((r) => r.text().includes('Discussion 1'))!.find('button').trigger('click');
      await settle();
      expect(highlighted(wrapper)).toEqual(['conv_001']);

      await startNew(wrapper);

      const store = useConversationsStore();
      expect(newRow(wrapper).exists()).toBe(true);
      expect(newRow(wrapper).attributes('data-conversation-id')).toBe(store.currentConversationId);
      expect(newRow(wrapper).text()).toContain('New discussion');
      expect(newRow(wrapper).text()).toContain('/home/user/project');
      expect(highlighted(wrapper)).toEqual([]);
      // First in the list, above the others.
      expect(wrapper.find('.divide-y > div').classes()).toContain('new-discussion-row');
    });

    it('is gone when another one is opened with nothing typed, and nothing was written for it', async () => {
      seedMany(3);
      const wrapper = await open();
      const before = savedIds();
      await startNew(wrapper);
      expect(newRow(wrapper).exists()).toBe(true);

      await rows(wrapper).find((r) => r.text().includes('Discussion 2'))!.find('button').trigger('click');
      await settle();

      expect(newRow(wrapper).exists()).toBe(false);
      expect(highlighted(wrapper)).toEqual(['conv_002']);
      expect(rows(wrapper)).toHaveLength(3);
      expect(savedIds()).toEqual(before);
    });

    it('becomes its own row once something is said in it', async () => {
      seedMany(2);
      const wrapper = await open();
      await startNew(wrapper);
      const id = useConversationsStore().currentConversationId!;

      useChatStore().addUserMessage('Sort the photos by date');
      await useConversationsStore().saveCurrentConversation();
      await settle();

      expect(newRow(wrapper).exists()).toBe(false);
      expect(rows(wrapper)).toHaveLength(3);
      expect(rows(wrapper)[0].attributes('data-conversation-id')).toBe(id);
      expect(rows(wrapper)[0].text()).toContain('Sort the photos by date');
      expect(highlighted(wrapper)).toEqual([id]);
    });

    it('is listed instead of "No conversations yet" when it is the first', async () => {
      const wrapper = await open();
      await startNew(wrapper);
      expect(newRow(wrapper).exists()).toBe(true);
      expect(wrapper.text()).not.toContain('No conversations yet');
    });

    it('is not in the Archived tab', async () => {
      seedMany(2);
      const wrapper = await open();
      await startNew(wrapper);
      await wrapper.findAll('[role="tab"]').find((t) => t.text().startsWith('Archived'))!.trigger('click');
      await settle();
      expect(newRow(wrapper).exists()).toBe(false);
    });
  });
});
