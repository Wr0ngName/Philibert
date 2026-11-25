/**
 * Rewinding a discussion, from the dialog to the file and back.
 *
 * Reported: after a rewind, the rewound messages stayed as they were, not
 * even identifiable as rewound. Asked for: they stay, greyed, under a
 * divider saying where the rewind went back to and what it restored — Claude
 * no longer has them, the user can still read them.
 *
 * Real: the window and the dialog, the stores, the conversation IPC and
 * ConversationService, and a restart on the same disk. Fake: what Claude
 * Code answers (the rewind's preview and outcome, the turns' uuids), Electron
 * and the filesystem.
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

import type { RewindOutcome, RewindPreview, RewindScope } from '@shared/types';

import { setupConversationIPC } from '../../../main/ipc/conversations';
import { ConversationService } from '../../../main/services/ConversationService';
import '../../../preload/preload';
import ChatWindow from '../../components/chat/ChatWindow.vue';
import RewindModal from '../../components/chat/RewindModal.vue';
import { useChatStore } from '../chat';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import {
  startRealStack, settle, emitIpc, mainHandlers, mountApp, unmountApp, send, onDisk, restartApp,
} from './support/real-stack';

const SESSION = 'session-of-the-discussion';

describe('rewinding a discussion', () => {
  let store: ReturnType<typeof useConversationsStore>;
  let app: ReturnType<typeof mount>;
  let dialog: ReturnType<typeof mount> | null = null;
  let id: string;
  /** What the next sends resolve to: the uuid each turn is sent under. */
  let turnUuids: string[];
  /** Each rewind asked of Claude Code: conversation, turn, scope, session. */
  let asked: unknown[][];
  let outcome: RewindOutcome;
  const preview: RewindPreview = { canRewind: true, filesChanged: ['src/a.ts'], insertions: 3, deletions: 1 };

  async function launch(): Promise<void> {
    store = useConversationsStore();
    const settings = useSettingsStore();
    settings.config.workingDirectory = '/home/user/project';
    settings.config.apiKey = 'test-key';
    await store.initialize();
    await settle(20);
    app = mountApp(ChatWindow);
    await settle(20);
  }

  /** A turn: the prompt, sent under its uuid, and Claude's answer — after a call of its own, when asked for. */
  async function turn(prompt: string, uuid: string, withCall = false): Promise<void> {
    turnUuids.push(uuid);
    await send(app, prompt);
    emitIpc('claude:session-id', id, SESSION);
    if (withCall) {
      emitIpc('claude:tool-capture', id, {
        toolUseBlockId: `toolu_${uuid}`, toolName: 'Read', input: { file_path: '/a' }, description: 'Read /a',
      });
      emitIpc('claude:tool-result', id, { toolUseBlockId: `toolu_${uuid}`, outputFile: '/tmp/out' });
    }
    emitIpc('claude:chunk', id, `answer to ${prompt}`);
    emitIpc('claude:done', id);
    await settle(20);
  }

  /** The rewind dialog, opened as the app opens it: mounted closed, then opened. */
  async function openDialog(): Promise<HTMLElement> {
    dialog?.unmount();
    dialog = mount(RewindModal, { props: { open: false }, attachTo: document.body });
    await dialog.setProps({ open: true });
    await settle(20);
    const found = [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => d.textContent?.includes('Rewind to'));
    if (!found) throw new Error('no rewind dialog');
    return found;
  }

  /** The turns the dialog offers to rewind to, newest first. */
  function offered(modal: HTMLElement): string[] {
    return [...modal.querySelectorAll<HTMLInputElement>('input[name="rewind-target"]')]
      .filter((input) => !input.disabled)
      .map((input) => input.closest('label')!.querySelector('.truncate')!.textContent!.trim());
  }

  /** Rewind to the turn whose prompt is `prompt`, restoring `scope`. */
  async function rewind(prompt: string, scope: RewindScope): Promise<HTMLElement> {
    const modal = await openDialog();
    const target = [...modal.querySelectorAll<HTMLInputElement>('input[name="rewind-target"]')]
      .find((input) => input.closest('label')!.textContent!.includes(prompt));
    if (!target) throw new Error(`no turn "${prompt}" to rewind to`);
    target.click();
    modal.querySelector<HTMLInputElement>(`input[name="rewind-scope"][value="${scope}"]`)!.click();
    await settle(20);
    [...modal.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Rewind')!.click();
    await settle(30);
    return modal;
  }

  /** Each message on screen: its text, and whether it is drawn rewound. */
  function onScreen(): [string, boolean][] {
    return app.findAll('.chat-row').flatMap((row) => {
      const text = row.find('.message-content');
      if (!text.exists()) return [];
      return [[text.text(), row.classes('rewound-row')] as [string, boolean]];
    });
  }

  /** Each stored message with text: its text, and whether it is marked rewound. */
  function stored(): [string, boolean][] {
    return (onDisk(id)?.messages ?? []).filter((m) => !m.toolUse).map((m) => [m.content, m.rewoundAt !== undefined]);
  }

  const divider = () => app.find('.rewind-divider');

  beforeEach(async () => {
    turnUuids = [];
    asked = [];
    outcome = { ok: true, filesChanged: ['src/a.ts'], insertions: 3, deletions: 1, conversationRewound: true };
    await startRealStack({
      ConversationService: ConversationService as unknown as new () => never,
      setupConversationIPC: setupConversationIPC as unknown as (service: never) => void,
    });
    mainHandlers.set('claude:send', () => turnUuids.shift() ?? null);
    // Claude Code's session is there: a send looks before it goes.
    mainHandlers.set('claude:session-exists', () => true);
    mainHandlers.set('claude:rewind-preview', () => preview);
    mainHandlers.set('claude:rewind-apply', (_event, ...args) => {
      asked.push(args);
      return outcome;
    });
    await launch();
    store.createNewConversation();
    id = store.currentConversationId!;
    await settle(10);
    await turn('one', 'uuid-1');
    await turn('two', 'uuid-2', true);
    await turn('three', 'uuid-3');
  });

  afterEach(() => {
    dialog?.unmount();
    dialog = null;
    unmountApp();
    document.body.innerHTML = '';
  });

  it('keeps the turns it went back over, greyed, under a divider saying what it did', async () => {
    await rewind('two', 'both');

    // Asked of Claude Code with the session the discussion is on.
    expect(asked).toEqual([[id, 'uuid-2', 'both', SESSION]]);
    expect(onScreen()).toEqual([
      ['one', false], ['answer to one', false],
      ['two', true], ['answer to two', true],
      ['three', true], ['answer to three', true],
    ]);
    expect(divider().text()).toContain('Rewound to "two" · 1 file restored (+3 / -1)');
    expect(divider().text()).toContain('Claude no longer has what follows');
    expect(divider().text()).toContain('src/a.ts');
    // Above the prompt rewound to, and only there.
    expect(app.findAll('.rewind-divider')).toHaveLength(1);
    const rows = app.findAll('.chat-row');
    const dividerAt = rows.findIndex((row) => row.find('.rewind-divider').exists());
    expect(rows[dividerAt + 1].find('.message-content').text()).toBe('two');
    // Each rewound prompt says so.
    expect(app.findAll('.rewound-tag').map((tag) => tag.text())).toEqual(['Rewound', 'Rewound']);
    // And nothing is said as Claude's: no note added to its answers.
    expect(app.text()).not.toContain('## Rewound');
  });

  it('greys every row from the prompt on — a turn\'s header and its calls too — and none before', async () => {
    await rewind('two', 'both');

    const rows = app.findAll('.chat-row').filter((row) => !row.find('.last-received').exists());
    const dividerAt = rows.findIndex((row) => row.find('.rewind-divider').exists());
    expect(rows.slice(0, dividerAt).some((row) => row.classes('rewound-row'))).toBe(false);
    expect(rows[dividerAt].classes('rewound-row')).toBe(false);
    const after = rows.slice(dividerAt + 1);
    // The prompt, the turn's header, its call, its answer; then the next turn.
    expect(after.length).toBeGreaterThanOrEqual(7);
    expect(after.every((row) => row.classes('rewound-row'))).toBe(true);
    expect(after.some((row) => row.find('.assistant-turn-header').exists())).toBe(true);
    expect(after.some((row) => row.find('.tool-use-entry').exists())).toBe(true);
  });

  it('keeps what follows the rewind Claude\'s, saved after saved', async () => {
    // The rewind is written once: the saves after it mark nothing more.
    await rewind('two', 'both');

    await turn('four', 'uuid-4');
    await turn('five', 'uuid-5');

    expect(stored().slice(-4)).toEqual([['four', false], ['answer to four', false], ['five', false], ['answer to five', false]]);
  });

  it('says so in a note when the turn left the screen while Claude Code rewound', async () => {
    // The window moved on meanwhile: the turn is not there to mark.
    mainHandlers.set('claude:rewind-apply', () => {
      const chat = useChatStore();
      chat.messages.splice(chat.messages.findIndex((m) => m.content === 'two'));
      return outcome;
    });

    await rewind('two', 'both');

    expect(divider().exists()).toBe(false);
    expect(app.text()).toContain('Rewound to "two" · 1 file restored (+3 / -1). The turns from there on are no longer Claude\'s.');
  });

  it('writes it at once, and it is there after a restart', async () => {
    await rewind('two', 'both');
    await settle(20);

    expect(stored()).toEqual([
      ['one', false], ['answer to one', false],
      ['two', true], ['answer to two', true],
      ['three', true], ['answer to three', true],
    ]);

    dialog?.unmount();
    dialog = null;
    restartApp();
    await launch();
    await store.switchConversation(id);
    await settle(20);

    expect(onScreen().map(([, rewound]) => rewound)).toEqual([false, false, true, true, true, true]);
    expect(divider().text()).toContain('Rewound to "two" · 1 file restored (+3 / -1)');
  });

  it('no longer offers a turn rewound away as a point to rewind to', async () => {
    await rewind('two', 'both');

    expect(offered(await openDialog())).toEqual(['one']);
  });

  it('goes on after the greyed turns, the new ones Claude\'s', async () => {
    await rewind('two', 'both');

    await turn('four', 'uuid-4');

    expect(onScreen().slice(-2)).toEqual([['four', false], ['answer to four', false]]);
    expect(stored().slice(-2)).toEqual([['four', false], ['answer to four', false]]);
    expect(offered(await openDialog())).toEqual(['four', 'one']);
  });

  it('rewound again from further back, keeps both dividers, the turns between greyed once', async () => {
    await rewind('three', 'conversation');
    await turn('four', 'uuid-4');

    await rewind('one', 'conversation');

    expect(onScreen().every(([, rewound]) => rewound)).toBe(true);
    expect(app.findAll('.rewind-divider').map((d) => d.text().split(' · ')[0])).toEqual([
      'Rewound to "one"', 'Rewound to "three"',
    ]);
  });

  it('of the conversation alone, says the files were kept as they are', async () => {
    outcome = { ok: true, filesChanged: [], insertions: 0, deletions: 0, conversationRewound: true };

    await rewind('three', 'conversation');

    expect(divider().text()).toContain('Rewound to "three" · files kept as they are');
    expect(onScreen().map(([, rewound]) => rewound)).toEqual([false, false, false, false, true, true]);
  });

  it('when no file differed, says so', async () => {
    outcome = { ok: true, filesChanged: [], insertions: 0, deletions: 0, conversationRewound: true };

    await rewind('three', 'both');

    expect(divider().text()).toContain('Rewound to "three" · no file differed from that point');
  });

  it('warns of a partial restore', async () => {
    outcome = { ok: true, filesChanged: ['src/a.ts'], insertions: 3, deletions: 1, skippedLinks: 2, conversationRewound: true };

    await rewind('two', 'both');

    expect(divider().text()).toContain('2 tracked files were left alone');
    expect(divider().text()).toContain('the restore was partial');
  });

  it('of files alone, leaves the conversation as it was and says what was restored at its end', async () => {
    outcome = { ok: true, filesChanged: ['src/a.ts'], insertions: 3, deletions: 1, conversationRewound: false };

    await rewind('two', 'code');

    expect(onScreen().every(([, rewound]) => !rewound)).toBe(true);
    expect(divider().exists()).toBe(false);
    // After the last message, the line saying when Claude was last heard from aside.
    const rows = app.findAll('.chat-row').filter((row) => !row.find('.last-received').exists());
    expect(rows.at(-1)!.text()).toContain('Files rewound to "two": 1 file restored (+3 / -1). The conversation goes on as it was.');
    expect(stored().every(([, rewound]) => !rewound)).toBe(true);
  });

  it('refused, changes nothing and says why in the dialog', async () => {
    outcome = {
      ok: false, error: "This turn is not in Claude Code's record of the discussion, so the conversation cannot be rewound to it. Nothing was changed.",
      filesChanged: [], insertions: 0, deletions: 0, conversationRewound: false,
    };

    const modal = await rewind('two', 'both');

    expect(modal.textContent).toContain('cannot be rewound to it. Nothing was changed.');
    expect(onScreen().every(([, rewound]) => !rewound)).toBe(true);
    expect(divider().exists()).toBe(false);
    expect(stored().every(([, rewound]) => !rewound)).toBe(true);
  });
});
