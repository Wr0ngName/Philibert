/**
 * What the discussion view shows while a discussion is being opened.
 *
 * Asked for: the first opening of a long discussion in a session reads its
 * whole file, which takes seconds — the view must say so, not sit empty or
 * keep showing the discussion left behind. And a quick opening must not
 * flash anything.
 *
 * Through the real store, the real preload and the real ConversationService,
 * with the disk's reads held to make the opening take as long as needed.
 */

import { mount } from '@vue/test-utils';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { Conversation } from '@shared/types';

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

// Imported after the mocks; importing the preload is what exposes the API.
import { ConversationService } from '../../../main/services/ConversationService';
import '../../../preload/preload';
import MessageList from '../../components/chat/MessageList.vue';
import { CONSTANTS } from '../../constants/app';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import { disk, files, releaseReads, settle, startRealStack } from './support/real-stack';

const DIR = '/home/user/project';
const DELAY = CONSTANTS.CONVERSATION.OPENING_PLACEHOLDER_DELAY_MS;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let store: ReturnType<typeof useConversationsStore>;
let list: ReturnType<typeof mount>;

function seed(id: string, contents: string[]): void {
  const conversation: Conversation = {
    id, title: contents[0], workingDirectory: DIR, createdAt: 1000, updatedAt: 2000,
    messages: contents.map((content, i) => ({ id: `${id}-${i}`, role: 'user', content, timestamp: 1000 + i })),
  };
  files.set(`/conversations/${id}.json`, JSON.stringify(conversation));
}

const placeholder = () => list.find('.message-list-opening');

beforeEach(async () => {
  await startRealStack({ ConversationService: ConversationService as unknown as new () => never, workingDirectory: DIR });
  store = useConversationsStore();
  useSettingsStore().config.workingDirectory = DIR;
  seed('conv-long', ['the first question', 'a later one']);
  await store.loadConversationList();
  await settle();
  list = mount(MessageList);
});

afterEach(() => {
  list.unmount();
});

describe('opening a discussion', () => {
  it('says it is opening once it takes a moment, and shows the discussion once read', async () => {
    disk.holdReads = true;
    const opening = store.loadConversation('conv-long');

    await wait(DELAY / 3);
    expect(placeholder().exists(), 'shown before the delay').toBe(false);

    await wait(DELAY);
    await settle();
    expect(placeholder().text()).toBe('Opening the discussion…');

    await releaseReads();
    await opening;
    await settle();
    expect(placeholder().exists()).toBe(false);
    expect(list.text()).toContain('the first question');
  });

  it('shows nothing for an opening that is quick', async () => {
    await store.loadConversation('conv-long');
    await settle();
    await wait(DELAY * 2);

    expect(placeholder().exists()).toBe(false);
    expect(list.text()).toContain('a later one');
  });

  it('stops saying so when the opening fails', async () => {
    disk.holdReads = true;
    disk.failReads = true;
    const opening = store.loadConversation('conv-long');
    await wait(DELAY * 2);
    await settle();
    expect(placeholder().exists()).toBe(true);

    await releaseReads();
    expect(await opening).toBe(false);
    await settle();
    expect(placeholder().exists()).toBe(false);
  });
});
