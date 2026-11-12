/**
 * What a message list shows, and how it pages.
 *
 * The discussion and an agent's transcript are the same kind of thing — a
 * prompt, what was said, the calls made and their results — so they are drawn
 * by the same list, with the same rows, styling, virtualisation and scrolling.
 * What differs is where the messages come from: a conversation is a window
 * onto a file, paged in and out as the reader scrolls and followed at its
 * tail; a transcript is a list held in full. A source is that difference.
 *
 * Properties are getters over reactive state, so the list tracks them like
 * any other reactive read.
 */

import type { ChatMessage } from '@shared/types';

import { useChatStore } from '../../stores/chat';
import { useConversationsStore } from '../../stores/conversations';

export interface MessageListSource {
  /**
   * What is being listed. The scroll position is remembered per key, and a
   * change of key is treated as switching to something else.
   */
  readonly key: string;
  /** The conversation the messages belong to — where their images are kept. */
  readonly conversationId: string;
  readonly messages: ChatMessage[];
  /** Whether a turn is running, which is what shows the spinner. */
  readonly isLoading: boolean;
  /**
   * Whether what is listed is still being read to be shown — a discussion
   * being opened, an agent's transcript before its first reading. The list
   * says so rather than showing an empty or a previous list meanwhile.
   */
  readonly opening: boolean;
  /**
   * When something last arrived from Claude in what is listed, said under it
   * once nothing is streaming; null when nothing has, or nothing to say.
   */
  readonly lastReceivedAt: number | null;
  /** Background tasks still running for what is listed, said with that time. */
  readonly runningTaskCount: number;
  /** The text streaming into the running turn, so the list can follow it. */
  readonly streamingContent: string;
  /**
   * How many of its own messages the list has gained since it was opened —
   * growth at the end, never a page loaded. Only its rise is meaningful.
   */
  readonly arrivals: number;
  /** Messages before and after the loaded ones that are not in memory. */
  readonly olderCount: number;
  readonly newerCount: number;
  readonly loadingEarlier: boolean;
  readonly loadingNewer: boolean;
  /** Where the messages were written, so a relative image path in them resolves. */
  readonly workingDirectory: string;
  /** Load the page before / after the loaded messages; how many arrived. */
  loadEarlier(): Promise<number>;
  loadNewer(): Promise<number>;
  /** Unload what the reader has moved away from, around this message. */
  slideAround(anchorMessageId: string): Promise<void>;
  /** Load the end of the list when the tail is not in memory. */
  jumpToLatest(): Promise<void>;
  /** Whether the view follows the tail, for the store's trimming. */
  setTailPinned(atBottom: boolean): void;
}

/** The conversation on screen, as the stores hold it. */
export function conversationListSource(): MessageListSource {
  const chatStore = useChatStore();
  const conversationsStore = useConversationsStore();
  const currentId = (): string => chatStore.currentConversationId ?? '';

  return {
    get key() { return currentId(); },
    get conversationId() { return currentId(); },
    get messages() { return chatStore.messages; },
    get isLoading() { return chatStore.isLoading; },
    get opening() { return conversationsStore.openingConversationId !== null; },
    get lastReceivedAt() { return chatStore.lastReceivedFor(currentId()); },
    get runningTaskCount() { return chatStore.runningBackgroundTaskCount(currentId()); },
    get streamingContent() { return chatStore.currentStreamingContent; },
    get arrivals() { return chatStore.arrivalCount(currentId()); },
    get olderCount() { return chatStore.olderMessageCount; },
    get newerCount() { return chatStore.newerMessageCount; },
    get loadingEarlier() { return conversationsStore.loadingEarlier; },
    get loadingNewer() { return conversationsStore.loadingNewer; },
    get workingDirectory() {
      const id = chatStore.currentConversationId;
      return id ? (conversationsStore.getConversationWorkingDirectory(id) ?? '') : '';
    },
    loadEarlier: () => conversationsStore.loadEarlierMessages(),
    loadNewer: () => conversationsStore.loadNewerMessages(),
    async slideAround(anchorMessageId) {
      const id = chatStore.currentConversationId;
      if (id) await conversationsStore.slideWindowAround(id, anchorMessageId);
    },
    async jumpToLatest() {
      await conversationsStore.jumpToLatest();
    },
    setTailPinned(atBottom) {
      const id = chatStore.currentConversationId;
      if (id) chatStore.setTailPinned(id, atBottom);
    },
  };
}

/** What a held-in-full list needs to say about itself. */
export interface HeldList {
  key: string;
  conversationId: string;
  messages: ChatMessage[];
  isLoading: boolean;
  workingDirectory: string;
  /** Not read yet: the list is mounted, sized, and says it is opening. */
  opening?: boolean;
}

/**
 * A list held in full, such as an agent's transcript: nothing to page, and
 * nothing streaming — it grows by whole messages.
 */
export function heldListSource(read: () => HeldList): MessageListSource {
  return {
    get key() { return read().key; },
    get conversationId() { return read().conversationId; },
    get messages() { return read().messages; },
    get isLoading() { return read().isLoading; },
    // Mounted before it is read, as the discussion's list is, so it has its
    // size when the messages arrive: mounted with them, it had none yet, and
    // the virtual list rendered every row of a long transcript at once.
    get opening() { return read().opening ?? false; },
    // An agent's transcript is read once it is written: its view says how the
    // agent is doing, so the list has no arrival time of its own to give.
    lastReceivedAt: null,
    runningTaskCount: 0,
    streamingContent: '',
    // Held in full, so it only ever grows by what arrived.
    get arrivals() { return read().messages.length; },
    olderCount: 0,
    newerCount: 0,
    loadingEarlier: false,
    loadingNewer: false,
    get workingDirectory() { return read().workingDirectory; },
    loadEarlier: async () => 0,
    loadNewer: async () => 0,
    slideAround: async () => undefined,
    jumpToLatest: async () => undefined,
    setTailPinned: () => undefined,
  };
}
