/**
 * Images, through the whole stack.
 *
 * The thing worth proving is not that each piece works but that the SPLIT
 * holds: a message carries a reference, the bytes live in the image store,
 * and both survive a save and a reload without the transcript ever carrying
 * the bytes. If that split leaked, every one of the memory and file-size
 * properties the window work established would quietly go with it — a
 * screenshot is one to three megabytes, and the conversation file is read
 * and parsed whole before every write.
 *
 * Real stores, real preload, real IPC handlers, real ConversationService and
 * real ImageStore. Only Electron and the filesystem are faked.
 */

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
import ChatWindow from '../../components/chat/ChatWindow.vue';
import { useChatStore } from '../chat';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import {
  startRealStack, settle, onDisk, files, mainHandlers, mountApp, unmountApp,
} from './support/real-stack';

const CONV = 'conv-with-pictures';

/** A real PNG, small but genuinely decodable. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('an image through the whole stack', () => {
  let store: ReturnType<typeof useConversationsStore>;
  let chatStore: ReturnType<typeof useChatStore>;

  beforeEach(async () => {
    await startRealStack({
      ConversationService: ConversationService as unknown as new () => never,
      setupConversationIPC: setupConversationIPC as unknown as (service: never) => void,
    });

    store = useConversationsStore();
    chatStore = useChatStore();
    const settings = useSettingsStore();
    settings.config.workingDirectory = '/home/user/project';
    settings.config.apiKey = 'test-key';
    await store.loadConversationList();
    await settle();

    store.currentConversationId = CONV;
    chatStore.setCurrentConversation(CONV);
  });

  afterEach(() => {
    unmountApp();
  });

  async function attach(label = 'shot.png') {
    const stored = await window.electron.conversation.saveImage(CONV, {
      base64: PNG_BASE64, mediaType: 'image/png', label,
    });
    expect(stored, 'the store refused the image').not.toBeNull();
    return stored!;
  }

  it('stores the bytes and gives back something small enough to put on a message', async () => {
    const ref = await attach();

    expect(ref.mediaType).toBe('image/png');
    expect(ref.origin).toBe('user');
    expect(ref.label).toBe('shot.png');
    // The reference is what travels and what gets saved.
    expect(JSON.stringify(ref)).not.toContain(PNG_BASE64);
  });

  it('reads the exact bytes back', async () => {
    const ref = await attach();

    const read = await window.electron.conversation.readImage(CONV, ref.id, ref.mediaType);

    expect(read?.base64).toBe(PNG_BASE64);
    expect(read?.mediaType).toBe('image/png');
  });

  it('keeps the bytes out of the conversation file', async () => {
    // The property the whole design exists for. A conversation file is read
    // and parsed before every single write; bytes in it would be paid for on
    // every save, by every save.
    const ref = await attach();
    chatStore.addUserMessage('what is this?', [ref]);
    await store.saveCurrentConversation();
    await settle();

    const raw = files.get(`/conversations/${CONV}.json`) ?? '';
    expect(raw).not.toContain(PNG_BASE64);
    expect(raw).toContain(ref.id);

    // And the size of the image makes no difference to the size of the
    // transcript, which is the property that matters: a file read and parsed
    // before every write must not grow with what the user attaches. A fixed
    // byte bound would only have been a guess about JSON overhead.
    const big = 'A'.repeat(200_000);
    const bigRef = await window.electron.conversation.saveImage(CONV, {
      base64: big, mediaType: 'image/png', label: 'big.png',
    });
    chatStore.addUserMessage('and this one?', [bigRef!]);
    await store.saveCurrentConversation();
    await settle();

    const withBig = files.get(`/conversations/${CONV}.json`) ?? '';
    expect(withBig).not.toContain(big);
    // Grew by another message and another reference — nothing like 200 KB.
    expect(withBig.length - raw.length).toBeLessThan(1_000);
  });

  it('keeps the reference on the message across a save and a reload', async () => {
    const ref = await attach();
    chatStore.addUserMessage('what is this?', [ref]);
    await store.saveCurrentConversation();
    await settle();

    // Reopen it the way a restart would.
    chatStore.loadMessages([]);
    await store.loadConversation(CONV);
    await settle();

    const reloaded = chatStore.messages.at(-1);
    expect(reloaded?.content).toBe('what is this?');
    expect(reloaded?.images).toEqual([ref]);
    // And the bytes are still there to draw.
    const read = await window.electron.conversation.readImage(CONV, ref.id, ref.mediaType);
    expect(read?.base64).toBe(PNG_BASE64);
  });

  it('carries several images on one message', async () => {
    const first = await attach('one.png');
    const second = await attach('two.png');
    expect(first.id).not.toBe(second.id);

    chatStore.addUserMessage('compare these', [first, second]);
    await store.saveCurrentConversation();
    await settle();

    expect(onDisk(CONV)?.messages.at(-1)?.images).toHaveLength(2);
  });

  it('puts the images a tool produced on the tool-use message', async () => {
    const produced = await attach('screenshot.png');
    chatStore.addAutoToolUseMessage(CONV, {
      toolUseBlockId: 'toolu_1',
      toolName: 'Read',
      input: { file_path: '/tmp/shot.png' },
      description: 'Read image',
    });

    chatStore.updateToolUseResult(CONV, {
      toolUseBlockId: 'toolu_1',
      outputFile: '/tmp/out.txt',
      content: '[image]',
      images: [produced],
    });

    const message = chatStore.messages.find((m) => m.toolUse?.toolUseBlockId === 'toolu_1');
    expect(message?.images).toEqual([produced]);
  });

  it('refuses a media type the API does not take, and says so by returning nothing', async () => {
    const refused = await window.electron.conversation.saveImage(CONV, {
      base64: PNG_BASE64, mediaType: 'image/svg+xml', label: 'diagram.svg',
    });

    // Not an exception: the renderer tells the user and carries on with the
    // message they were writing.
    expect(refused).toBeNull();
  });

  it('forgets the bytes when the conversation is deleted', async () => {
    const ref = await attach();
    chatStore.addUserMessage('what is this?', [ref]);
    await store.saveCurrentConversation();
    await settle();

    await store.deleteConversation(CONV);
    await settle();

    // These are the largest files this app writes; left behind, nothing would
    // ever name them again.
    expect(await window.electron.conversation.readImage(CONV, ref.id, ref.mediaType)).toBeNull();
    for (const path of files.keys()) {
      expect(path).not.toContain(ref.id);
    }
  });

  it('sends a pasted picture to Claude from the composer', async () => {
    // The reported failure: "Failed to send message to Claude", and nothing
    // in the main log. The composer kept its attachments in a ref, so each
    // one was a reactive proxy, and Electron cannot copy a proxy across the
    // process boundary — the send threw in the renderer before main ever
    // saw it. Every piece worked alone; only the whole path shows it.
    const sends: unknown[][] = [];
    mainHandlers.set('claude:send', (_event, ...args) => {
      sends.push(args);
    });
    const wrapper = mountApp(ChatWindow);

    const bytes = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));
    await wrapper.find('textarea').trigger('paste', {
      clipboardData: { files: [new File([bytes], 'shot.png', { type: 'image/png' })] },
    });
    await vi.waitFor(() => {
      expect(wrapper.find('[aria-label="Remove shot.png"]').exists(), 'the paste never became an attachment').toBe(true);
    });

    await wrapper.find('textarea').setValue('what is this?');
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
    await settle();

    expect(chatStore.error).toBeNull();
    expect(sends).toHaveLength(1);
    const [conversationId, message, , , images] = sends[0] as [string, string, string, string, unknown];
    expect(conversationId).toBe(CONV);
    expect(message).toBe('what is this?');
    expect(images).toEqual([expect.objectContaining({ mediaType: 'image/png', origin: 'user', label: 'shot.png' })]);
  });

  it('shows a gap rather than failing when the bytes have gone', async () => {
    const ref = await attach();
    chatStore.addUserMessage('what is this?', [ref]);
    await store.saveCurrentConversation();
    await settle();

    // The file disappears underneath the reference — a half-restored backup,
    // a cleaned directory.
    for (const path of [...files.keys()]) {
      if (path.includes('/images/')) files.delete(path);
    }

    expect(await window.electron.conversation.readImage(CONV, ref.id, ref.mediaType)).toBeNull();
    // The transcript is intact; only the picture is missing.
    const stored = onDisk(CONV) as Conversation;
    expect(stored.messages.at(-1)?.content).toBe('what is this?');
  });
});
