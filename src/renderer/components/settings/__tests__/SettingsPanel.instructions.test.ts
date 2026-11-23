/**
 * What Claude is told before a discussion's first message, in Settings
 * (@shared/system-prompt): Claude Code's system prompt in git repositories,
 * always or never, and instructions after it — in general, saved with the
 * dialog, and for a project, saved on its page as they change.
 *
 * The dialog is real, its stores too; only the preload API is faked
 * (support/settings-boundary), with git's answer about the project's folder.
 */

import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG } from '@shared/types';

import { useSettingsStore } from '../../../stores/settings';

import { fakeElectron, mountSettings } from './support/settings-boundary';

const PROJECT = '/home/user/project';

let api: ReturnType<typeof fakeElectron>;
const mounted: ReturnType<typeof mountSettings>[] = [];

function mountPanel() {
  const wrapper = mountSettings();
  mounted.push(wrapper);
  return wrapper;
}

type Wrapper = ReturnType<typeof mountPanel>;

function modes(wrapper: Wrapper, prefix: string) {
  return wrapper.findAll(`[role="radiogroup"][aria-labelledby="${prefix}-mode-label"] [role="radio"]`);
}

function chosenMode(wrapper: Wrapper, prefix: string): string[] {
  return modes(wrapper, prefix).filter((mode) => mode.attributes('aria-checked') === 'true').map((mode) => mode.find('.font-medium').text());
}

async function choose(wrapper: Wrapper, prefix: string, label: string): Promise<void> {
  const mode = modes(wrapper, prefix).find((candidate) => candidate.find('.font-medium').text() === label);
  if (!mode) throw new Error(`no "${label}"`);
  await mode.trigger('click');
  await flushPromises();
}

async function save(wrapper: Wrapper): Promise<void> {
  const button = wrapper.findAll('button').find((candidate) => candidate.text() === 'Save Changes');
  if (!button) throw new Error('no Save Changes button');
  await button.trigger('click');
  await flushPromises();
}

async function openProject(wrapper: Wrapper): Promise<void> {
  await wrapper.find('#settings-tab-project-0').trigger('click');
  await flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  api = fakeElectron({ conversation: { projectFolders: vi.fn().mockResolvedValue({ active: [PROJECT], archived: [] }) } });
  useSettingsStore().config = { ...DEFAULT_CONFIG, workingDirectory: PROJECT };
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

describe('the general instructions', () => {
  it("start on Claude Code's prompt in git repositories, and no instructions", async () => {
    const wrapper = mountPanel();
    await flushPromises();

    expect(chosenMode(wrapper, 'general-prompt')).toEqual(['In git repositories']);
    expect((wrapper.find('#general-prompt-instructions').element as HTMLTextAreaElement).value).toBe('');
  });

  it('are saved with the dialog, the instructions trimmed', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    await choose(wrapper, 'general-prompt', 'Never');
    await wrapper.find('#general-prompt-instructions').setValue('  Answer in French.  \n');
    expect(api.config!.set).not.toHaveBeenCalledWith(expect.objectContaining({ claudeCodePrompt: 'off' }));
    await save(wrapper);

    expect(api.config!.set).toHaveBeenCalledWith({ claudeCodePrompt: 'off' });
    expect(api.config!.set).toHaveBeenCalledWith({ customInstructions: 'Answer in French.' });
    expect(useSettingsStore().config).toMatchObject({ claudeCodePrompt: 'off', customInstructions: 'Answer in French.' });
  });

  it('are put back as they were when the dialog is cancelled', async () => {
    useSettingsStore().config.customInstructions = 'Answer in French.';
    const wrapper = mountPanel();
    await flushPromises();

    await choose(wrapper, 'general-prompt', 'Always');
    await wrapper.find('#general-prompt-instructions').setValue('Something else');
    await wrapper.findAll('button').find((candidate) => candidate.text() === 'Cancel')!.trigger('click');
    await flushPromises();

    expect(chosenMode(wrapper, 'general-prompt')).toEqual(['In git repositories']);
    expect((wrapper.find('#general-prompt-instructions').element as HTMLTextAreaElement).value).toBe('Answer in French.');
    expect(api.config!.set).not.toHaveBeenCalled();
  });
});

describe("a project's instructions", () => {
  it('follow the general setting, saying what it comes to in a git repository', async () => {
    api.git!.status = vi.fn().mockResolvedValue({ isGitRepo: true, branch: 'main', dirty: 0, ahead: 0, behind: 0 });
    const wrapper = mountPanel();
    await flushPromises();
    await openProject(wrapper);

    expect(api.git!.status).toHaveBeenCalledWith(PROJECT);
    expect(chosenMode(wrapper, 'project-prompt')).toEqual(['As in general']);
    const general = modes(wrapper, 'project-prompt')[0]!;
    expect(general.find('.system-prompt-mode-description').text()).toBe('Used here');
  });

  it('say the general setting is not used here when it is never, even in a git repository', async () => {
    api.git!.status = vi.fn().mockResolvedValue({ isGitRepo: true, branch: 'main', dirty: 0, ahead: 0, behind: 0 });
    useSettingsStore().config.claudeCodePrompt = 'off';
    const wrapper = mountPanel();
    await flushPromises();
    await openProject(wrapper);

    expect(modes(wrapper, 'project-prompt')[0]!.find('.system-prompt-mode-description').text()).toBe('Not used here');
  });

  it('say the general setting is not used in a folder that is no git repository', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    await openProject(wrapper);

    expect(modes(wrapper, 'project-prompt')[0]!.find('.system-prompt-mode-description').text()).toBe('Not used here');
  });

  it('are saved as they change: the choice at once, the instructions once their box is left', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    await openProject(wrapper);

    await choose(wrapper, 'project-prompt', 'Never here');
    expect(api.config!.set).toHaveBeenLastCalledWith({ projectSystemPrompts: { [PROJECT]: { claudeCodePrompt: 'off' } } });
    expect(chosenMode(wrapper, 'project-prompt')).toEqual(['Never here']);

    const box = wrapper.find('#project-prompt-instructions');
    await box.setValue(' Commit messages on one line. ');
    expect(api.config!.set).toHaveBeenLastCalledWith({
      projectSystemPrompts: { [PROJECT]: { claudeCodePrompt: 'off', instructions: 'Commit messages on one line.' } },
    });

    await choose(wrapper, 'project-prompt', 'As in general');
    expect(api.config!.set).toHaveBeenLastCalledWith({ projectSystemPrompts: { [PROJECT]: { instructions: 'Commit messages on one line.' } } });
  });

  it('forget the project once it has neither its own choice nor instructions', async () => {
    useSettingsStore().config.projectSystemPrompts = { [PROJECT]: { instructions: 'Commit messages on one line.' }, '/elsewhere': { claudeCodePrompt: 'on' } };
    const wrapper = mountPanel();
    await flushPromises();
    await openProject(wrapper);

    const box = wrapper.find('#project-prompt-instructions');
    expect((box.element as HTMLTextAreaElement).value).toBe('Commit messages on one line.');
    await box.setValue('');

    expect(api.config!.set).toHaveBeenLastCalledWith({ projectSystemPrompts: { '/elsewhere': { claudeCodePrompt: 'on' } } });
  });
});
