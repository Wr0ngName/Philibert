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
  /** The text streaming into the running turn, so the list can follow it. */
  readonly streamingContent: string;
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
    get streamingContent() { return chatStore.currentStreamingContent; },
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
    streamingContent: '',
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
