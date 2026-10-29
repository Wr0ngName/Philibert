/**
 * Tool Details shows the images a call produced, as the discussion does.
 *
 * Reported as: Tool Details of a Read of a .png showed "Output [image]" — the
 * placeholder the result's text holds so it does not read as empty — while
 * the discussion drew the image. The images are kept on the call's message,
 * and Tool Details was given the call alone.
 *
 * Real ChatWindow, real stores, real preload, real conversation IPC handlers
 * (images included) and the real ConversationService, as in
 * background-task-detail.roundtrip. An agent's transcript comes from the real
 * converter, its images stored by the real ImageStore.
 */

import { mount } from '@vue/test-utils';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { ChatMessage, MessageImage, ToolCaptureData } from '@shared/types';

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
import { ImageStore } from '../../../main/services/ImageStore';
import { attachTranscriptImages, transcriptToMessages, type FoundImages } from '../../../main/services/claude/task-output';
import '../../../preload/preload';
import ChatWindow from '../../components/chat/ChatWindow.vue';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import {
  startRealStack, settle, emitIpc, mainHandlers, mountApp, unmountApp, send,
} from './support/real-stack';

/** A real, if tiny, PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('images in Tool Details', () => {
  let store: ReturnType<typeof useConversationsStore>;
  let app: ReturnType<typeof mount>;
  let conversationId: string;
  let results: Map<string, string>;

  function call(capture: ToolCaptureData): void {
    emitIpc('claude:tool-capture', conversationId, capture);
  }

  function result(toolUseBlockId: string, content: string, images?: MessageImage[]): void {
    const outputFile = `/results/${toolUseBlockId}.txt`;
    results.set(outputFile, content);
    emitIpc('claude:tool-result', conversationId, { toolUseBlockId, outputFile, ...(images && { images }) });
  }

  function dialog(title: string): HTMLElement | null {
    return [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')]
      .find((d) => d.querySelector('h2, h3')?.textContent?.includes(title) || d.textContent?.startsWith(title)) ?? null;
  }

  /** The last open dialog whose text includes `title`: a nested one opens over its parent. */
  function topDialog(title: string): HTMLElement | null {
    return [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')]
      .filter((d) => d.textContent?.includes(title)).at(-1) ?? dialog(title);
  }

  async function clickCall(root: ParentNode, text: string): Promise<void> {
    const row = [...root.querySelectorAll<HTMLElement>('.tool-use-entry')].find((r) => r.textContent?.includes(text));
    expect(row, `expected a call reading "${text}"`).toBeDefined();
    row!.click();
    await settle(20);
  }

  /** The text of the Output section, which follows its heading. */
  function outputSection(modal: HTMLElement): string {
    const text = modal.textContent ?? '';
    return text.slice(text.lastIndexOf('Output'));
  }

  async function image(): Promise<MessageImage> {
    const ref = await window.electron.conversation.saveImage(conversationId, {
      base64: PNG_BASE64, mediaType: 'image/png', label: 'gui_data2.png',
    });
    return ref!;
  }

  beforeEach(async () => {
    await startRealStack({
      ConversationService: ConversationService as unknown as new () => never,
      setupConversationIPC: setupConversationIPC as unknown as (service: never) => void,
    });
    mainHandlers.set('claude:send', () => undefined);
    results = new Map();
    mainHandlers.set('files:read', (_event, file) => results.get(file as string) ?? '');

    store = useConversationsStore();
    const settings = useSettingsStore();
    settings.config.workingDirectory = '/home/user/project';
    settings.config.apiKey = 'test-key';
    await store.loadConversationList();
    await settle();
    app = mountApp(ChatWindow);
    await settle();
    store.createNewConversation();
    conversationId = store.currentConversationId!;
    await send(app, 'look at the screenshot');
  });

  afterEach(() => {
    unmountApp();
    document.body.innerHTML = '';
  });

  it('shows the image of a Read, not the "[image]" its text holds', async () => {
    call({ toolUseBlockId: 'toolu_read', toolName: 'Read', input: { file_path: 'out/gui_data2.png' }, description: 'Read: out/gui_data2.png' });
    result('toolu_read', '[image]', [await image()]);
    await settle(20);

    await clickCall(app.element, 'gui_data2.png');

    const modal = topDialog('Tool Details');
    expect(modal, 'expected Tool Details').not.toBeNull();
    expect(modal!.querySelectorAll('figure')).toHaveLength(1);
    expect(outputSection(modal!)).not.toContain('[image]');
  });

  it('keeps text a result has beside its image', async () => {
    call({ toolUseBlockId: 'toolu_pdf', toolName: 'Read', input: { file_path: 'doc.pdf', pages: '1' }, description: 'Read: doc.pdf' });
    result('toolu_pdf', 'Page 1 of 3', [await image()]);
    await settle(20);

    await clickCall(app.element, 'doc.pdf');

    const modal = topDialog('Tool Details')!;
    expect(modal.querySelectorAll('figure')).toHaveLength(1);
    expect(outputSection(modal)).toContain('Page 1 of 3');
  });

  it("shows the image an agent's Read produced in the call's details", async () => {
    // The agent's transcript as the SDK reads it back: the image is an image
    // block of the tool_result content. Main converts it and stores the image
    // with the real store, as getAgentTranscript does.
    const imageStore = new ImageStore();
    mainHandlers.set('claude:get-agent-transcript', async (_event, conv): Promise<ChatMessage[]> => {
      const found: FoundImages[] = [];
      const messages = transcriptToMessages([
        {
          type: 'user', uuid: 'u-prompt', session_id: 's', parent_tool_use_id: null, timestamp: '2026-10-29T21:00:00.000Z',
          message: { role: 'user', content: 'Look at gui_data2.png' },
        },
        {
          type: 'assistant', uuid: 'u-call', session_id: 's', parent_tool_use_id: null, timestamp: '2026-10-29T21:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_sub_read', name: 'Read', input: { file_path: 'out/gui_data2.png' } }] },
        },
        {
          type: 'user', uuid: 'u-result', session_id: 's', parent_tool_use_id: null, timestamp: '2026-10-29T21:00:02.000Z',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sub_read', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } },
          ] }] },
        },
      ] as never, (id, content) => {
        results.set(`/results/${id}.txt`, content);
        return `/results/${id}.txt`;
      }, (message, images) => found.push({ message, images }));
      await attachTranscriptImages(found, (input) => imageStore.saveOnce(conv as string, input));
      return messages;
    });
    call({ toolUseBlockId: 'toolu_agent', toolName: 'Agent', input: { description: 'Inspect the GUI', subagent_type: 'builder', prompt: 'Look at gui_data2.png' }, description: 'Agent: Inspect the GUI' });
    emitIpc('claude:task-notification', conversationId, { taskId: 'agent-1', status: 'running', description: 'Inspect the GUI', toolUseId: 'toolu_agent', taskType: 'agent', agentType: 'builder', backgrounded: false });
    await settle(20);

    await clickCall(app.element, 'Inspect the GUI');
    const task = topDialog('Task Details');
    expect(task, 'expected the agent view').not.toBeNull();

    await clickCall(task!, 'gui_data2.png');
    const details = topDialog('Tool Details');
    expect(details, 'expected Tool Details for the agent call').not.toBeNull();
    expect(details!.querySelectorAll('figure')).toHaveLength(1);
    expect(outputSection(details!)).not.toContain('[image]');
  });
});
