/**
 * A discussion's system prompt, as the renderer handles it. Claude Code keeps
 * the prompt a discussion started on (@shared/system-prompt): the renderer
 * keeps what it was told the CLI recorded, saves it with the discussion, and
 * says — at the top of the discussion — when that is not what the settings ask
 * for now, with the change to review: go on with it as it is, or start a new
 * discussion. A discussion started before this was kept is said to be legacy.
 *
 * Real ChatWindow, real stores, real preload, real conversation IPC handlers
 * and the real ConversationService; only Electron and the filesystem are
 * faked, with git's answer about the folder.
 */

import type { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { SystemPromptChoice } from '@shared/system-prompt';
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
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import {
  emitIpc, files, mainHandlers, mountApp, onDisk, send, sessionOnDisk, settle, startRealStack, unmountApp,
} from './support/real-stack';

const DIR = '/home/user/project';
const FRENCH: SystemPromptChoice = { claudeCodePrompt: false, instructions: 'Answer in French.' };

let store: ReturnType<typeof useConversationsStore>;
let settings: ReturnType<typeof useSettingsStore>;
let app: ReturnType<typeof mount>;
/** What git says of the folder: whether it is a repository. */
let isGitRepo: boolean;

/** As the main process does: a new discussion's session records the prompt it starts on, the settings'. */
function settingsPrompt(): SystemPromptChoice {
  const claudeCodePrompt = settings.config.claudeCodePrompt === 'on' || (settings.config.claudeCodePrompt === 'auto' && isGitRepo);
  return { claudeCodePrompt, instructions: settings.config.customInstructions };
}

/** Fresh stores, ChatWindow mounted: the app as it starts, signed in, in the folder. */
async function startApp(): Promise<void> {
  setActivePinia(createPinia());
  store = useConversationsStore();
  settings = useSettingsStore();
  settings.config.workingDirectory = DIR;
  settings.config.apiKey = 'test-key';
  settings.config.claudeCodePrompt = 'off';
  settings.config.customInstructions = FRENCH.instructions;
  await store.loadConversationList();
  await settle();
  app = mountApp(ChatWindow);
  await settle();
}

beforeEach(async () => {
  await startRealStack({
    ConversationService: ConversationService as unknown as new () => never,
    setupConversationIPC: setupConversationIPC as unknown as (service: never) => void,
    workingDirectory: DIR,
  });
  isGitRepo = false;
  mainHandlers.set('claude:send', (_event, conversationId, _prompt, _cwd, resume) => {
    if (!resume) emitIpc('claude:system-prompt-recorded', conversationId, settingsPrompt());
    return null;
  });
  mainHandlers.set('claude:session-exists', () => true);
  mainHandlers.set('git:status', () => ({ isGitRepo, branch: 'main', dirty: 0, ahead: 0, behind: 0 }));
  await startApp();
});

afterEach(() => {
  unmountApp();
  document.body.innerHTML = '';
});

/** A turn in the discussion on screen, answered as Claude Code does. */
async function turn(prompt: string): Promise<string> {
  const id = store.currentConversationId!;
  await send(app, prompt);
  sessionOnDisk(`session-${id}`);
  emitIpc('claude:session-id', id, `session-${id}`);
  emitIpc('claude:chunk', id, `answer to ${prompt}`);
  emitIpc('claude:done', id);
  await settle(20);
  return id;
}

/** The banner's text, by kind, in the discussion on screen; null when not shown. */
function banner(kind: 'differs' | 'legacy'): string | null {
  const found = app.find(`[data-testid="system-prompt-${kind}"]`);
  return found.exists() ? found.text().replace(/\s+/g, ' ') : null;
}

/** The review's text, by side; null when it is not open. The dialog is in the page's body, as Modal puts it. */
function reviewSide(side: 'recorded' | 'current'): string | null {
  return document.querySelector(`[data-testid="system-prompt-${side}"]`)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
}

/** Press one of the review's buttons. */
async function inReview(button: 'keep' | 'start-new'): Promise<void> {
  const found = document.querySelector<HTMLElement>(`[data-testid="system-prompt-${button}"]`);
  if (!found) throw new Error(`The review has no ${button} button`);
  found.click();
  await settle(20);
}

async function setInstructions(instructions: string): Promise<void> {
  await settings.setCustomInstructions(instructions);
  await settle();
}

describe('a discussion on the settings\' system prompt', () => {
  it('says nothing, before its first message and after', async () => {
    store.createNewConversation();
    await settle();
    expect(banner('differs')).toBeNull();
    expect(banner('legacy')).toBeNull();

    await turn('hello');

    expect(banner('differs')).toBeNull();
    expect(banner('legacy')).toBeNull();
  });
});

describe('a discussion the settings changed after it started', () => {
  it('says so, and the review shows what it runs on beside what the settings ask for', async () => {
    store.createNewConversation();
    await turn('hello');

    await setInstructions('Answer in German.');

    expect(banner('differs')).toContain('System prompt changed.');
    await app.find('[data-testid="system-prompt-review"]').trigger('click');
    await settle();
    expect(reviewSide('recorded')).toBe('This discussion Claude Code\'s system prompt: off Instructions Answer in French.');
    expect(reviewSide('current')).toBe('Settings now Claude Code\'s system prompt: off Instructions Answer in German.');
  });

  it('gone on with as it is, says nothing more — after a restart too — until the settings change again', async () => {
    store.createNewConversation();
    const id = await turn('hello');
    await setInstructions('Answer in German.');
    await app.find('[data-testid="system-prompt-review"]').trigger('click');
    await settle();

    await inReview('keep');

    expect(banner('differs')).toBeNull();
    expect(onDisk(id)?.systemPromptKeptUnder).toEqual({ claudeCodePrompt: false, instructions: 'Answer in German.' });

    unmountApp();
    await startApp();
    settings.config.customInstructions = 'Answer in German.';
    await store.loadConversation(id);
    await settle(20);
    expect(banner('differs')).toBeNull();

    await setInstructions('Answer in Spanish.');
    expect(banner('differs')).toContain('System prompt changed.');
  });

  it('left for a new discussion, which starts on the settings and says nothing', async () => {
    store.createNewConversation();
    const old = await turn('hello');
    await setInstructions('Answer in German.');
    await app.find('[data-testid="system-prompt-review"]').trigger('click');
    await settle();

    await inReview('start-new');

    expect(store.currentConversationId).not.toBe(old);
    await turn('fresh start');
    expect(banner('differs')).toBeNull();
  });

  it('says so of the Claude Code prompt as the folder has it: by default, on in a git repository only', async () => {
    isGitRepo = true;
    settings.config.claudeCodePrompt = 'auto';
    store.createNewConversation();
    await turn('hello');
    // Started on Claude Code's prompt: the folder is a repository.
    expect(banner('differs')).toBeNull();

    settings.config.claudeCodePrompt = 'off';
    await settle();

    expect(banner('differs')).toContain('System prompt changed.');
  });

  it('sees its folder made a git repository after it was opened, as its session started in one', async () => {
    settings.config.claudeCodePrompt = 'auto';
    store.createNewConversation();
    await settle();
    // `git init`, outside the app, before the first message.
    isGitRepo = true;

    await turn('hello');

    expect(banner('differs')).toBeNull();
  });

  it("does not take another folder's git answer for its own's while git has not said", async () => {
    settings.config.claudeCodePrompt = 'auto';
    isGitRepo = true;
    store.createNewConversation();
    const inRepository = await turn('hello');
    // A discussion in a folder that is no repository, started on no Claude Code prompt.
    const at = Date.now() - 1000;
    const plain: Conversation = {
      id: 'plain', title: 'Plain', workingDirectory: '/home/user/plain', createdAt: at, updatedAt: at, sdkSessionId: 'session-plain',
      recordedSystemPrompt: { claudeCodePrompt: false, instructions: FRENCH.instructions },
      messages: [{ id: 'q', role: 'user', content: 'q', timestamp: at }, { id: 'a', role: 'assistant', content: 'a', timestamp: at }],
    };
    files.set('/conversations/plain.json', JSON.stringify(plain));
    sessionOnDisk('session-plain');
    // Git is slow to answer for it.
    let answer!: () => void;
    mainHandlers.set('git:status', (_event, dir) => (dir === '/home/user/plain'
      ? new Promise((resolve) => { answer = () => resolve({ isGitRepo: false, branch: '', dirty: 0, ahead: 0, behind: 0 }); })
      : { isGitRepo: true, branch: 'main', dirty: 0, ahead: 0, behind: 0 }));

    await store.loadConversation('plain');
    await settle(20);
    expect(store.currentConversationId).not.toBe(inRepository);
    expect(banner('differs')).toBeNull();

    answer();
    await settle();
    expect(banner('differs')).toBeNull();
  });

  it("says so of its project's own settings, which are its folder's", async () => {
    store.createNewConversation();
    await turn('hello');

    await settings.setProjectSystemPrompt(DIR, { instructions: 'Commit messages on one line.' });
    await settle();
    expect(banner('differs')).toContain('System prompt changed.');

    // Another folder's are not its own, even made the app's folder meanwhile.
    await settings.setProjectSystemPrompt(DIR, { instructions: '' });
    await settings.setProjectSystemPrompt('/home/user/other', { instructions: 'Not here.' });
    settings.config.workingDirectory = '/home/user/other';
    await settle();
    expect(banner('differs')).toBeNull();
  });

  it('says nothing once archived: the archive has its own bar', async () => {
    store.createNewConversation();
    const id = await turn('hello');
    await setInstructions('Answer in German.');
    expect(banner('differs')).not.toBeNull();

    await store.setConversationArchived(id, true);
    await settle(20);

    expect(banner('differs')).toBeNull();
  });

  it('back on the settings once the CLI records the prompt anew, as a compaction summarizing everything does', async () => {
    store.createNewConversation();
    const id = await turn('hello');
    await setInstructions('Answer in German.');
    expect(banner('differs')).not.toBeNull();

    emitIpc('claude:system-prompt-recorded', id, { claudeCodePrompt: false, instructions: 'Answer in German.' });
    await settle();

    expect(banner('differs')).toBeNull();
  });

  it('keeps what it runs on across a restart', async () => {
    store.createNewConversation();
    const id = await turn('hello');
    expect(onDisk(id)?.recordedSystemPrompt).toEqual(FRENCH);

    unmountApp();
    await startApp();
    settings.config.customInstructions = 'Answer in German.';
    await store.loadConversation(id);
    await settle(20);

    expect(banner('differs')).toContain('System prompt changed.');
  });
});

describe('a discussion started before the app kept its system prompt', () => {
  beforeEach(async () => {
    const at = Date.now() - 1000;
    const legacy: Conversation = {
      id: 'legacy', title: 'Old', workingDirectory: DIR, createdAt: at, updatedAt: at, sdkSessionId: 'session-legacy',
      messages: [
        { id: 'q', role: 'user', content: 'q', timestamp: at },
        { id: 'a', role: 'assistant', content: 'a', timestamp: at },
      ],
    };
    files.set('/conversations/legacy.json', JSON.stringify(legacy));
    sessionOnDisk('session-legacy');
    await store.loadConversation('legacy');
    await settle(20);
  });

  it('is said to be legacy, a new discussion offered', async () => {
    expect(banner('legacy')).toBe(
      'Legacy discussion. It started before Philibert kept track of its system prompt, so newer settings may not apply to it. Open a new discussion when you are ready, to get them. New discussion',
    );

    await app.find('[data-testid="system-prompt-start-new"]').trigger('click');
    await settle(20);

    expect(store.currentConversationId).not.toBe('legacy');
    expect(banner('legacy')).toBeNull();
  });

  it('is still said to be legacy as it goes on: resuming it records nothing', async () => {
    await turn('still there?');

    expect(banner('legacy')).not.toBeNull();
  });
});
