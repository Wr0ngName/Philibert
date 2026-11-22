/**
 * The working folder atop the files panel, beside the settings dialog as in
 * the app: the path changes the folder, and the gear opens the settings at
 * the project's own, about that folder — whatever was picked there before.
 *
 * Every component and store is real; only the preload API is faked
 * (support/settings-boundary), with the folder picker the user answers.
 */

import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

import { DEFAULT_CONFIG } from '@shared/types';

import { useMcpStore } from '../../../stores/mcp';
import { useSettingsStore } from '../../../stores/settings';
import { useUiStore } from '../../../stores/ui';
import SettingsPanel from '../../settings/SettingsPanel.vue';
import { fakeElectron } from '../../settings/__tests__/support/settings-boundary';
import WorkingDirectory from '../WorkingDirectory.vue';

const HERE = '/home/user/here';
const THERE = '/home/user/there';

/** The files panel's folder row and the settings dialog, wired to the ui store as App.vue wires them. */
const Shell = defineComponent(() => {
  const ui = useUiStore();
  return () => [
    h(WorkingDirectory),
    h(SettingsPanel, { open: ui.showSettings, onClose: () => ui.closeSettings() }),
  ];
});

let files: Record<string, ReturnType<typeof vi.fn>>;
let mcp: Record<string, ReturnType<typeof vi.fn>>;
let conversation: Record<string, ReturnType<typeof vi.fn>>;
let wrapper: ReturnType<typeof mount> | null = null;

async function mountShell() {
  wrapper = mount(Shell, { attachTo: document.body, global: { stubs: { teleport: true } } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  files = {
    selectDirectory: vi.fn(),
    listDirectory: vi.fn().mockResolvedValue([]),
    onChange: vi.fn().mockReturnValue(() => {}),
  };
  mcp = {
    list: vi.fn().mockResolvedValue([]),
    projectTools: vi.fn().mockResolvedValue({ statuses: [], userServers: [], offEverywhere: [] }),
  };
  conversation = { projectFolders: vi.fn().mockResolvedValue({ active: [THERE], archived: [] }) };
  fakeElectron({ files, mcp, conversation });
  useSettingsStore().config = { ...DEFAULT_CONFIG, workingDirectory: HERE };
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('the working folder', () => {
  it('changes the folder when its path is clicked', async () => {
    files.selectDirectory.mockResolvedValue(THERE);
    const shell = await mountShell();

    const path = shell.find('.working-directory-change');
    expect(path.element.tagName).toBe('BUTTON');
    expect(path.attributes('aria-label')).toBe(`Change folder: ${HERE}`);
    await path.trigger('click');
    await flushPromises();

    expect(files.selectDirectory).toHaveBeenCalledTimes(1);
    expect(useSettingsStore().workingDirectory).toBe(THERE);
    expect(shell.find('.working-directory-change').text()).toBe('.../user/there');
  });

  it('opens the settings at the project\'s own, about this folder, even after another was picked there', async () => {
    const shell = await mountShell();
    useMcpStore().pickProject(THERE);

    await shell.find('.working-directory-settings').trigger('click');
    await flushPromises();

    expect(useUiStore().showSettings).toBe(true);
    expect(shell.find('#settings-tab-project-0').attributes('aria-selected')).toBe('true');
    expect(shell.find('#settings-tab-project-0').attributes('title')).toBe(HERE);
    expect(shell.find('#settings-tab-project-1').attributes('aria-selected')).toBe('false');
    expect(shell.find('#settings-page-project').isVisible()).toBe(true);
    expect(shell.find('.project-settings-path').text()).toBe(HERE);
    expect(mcp.projectTools).toHaveBeenLastCalledWith(HERE);
  });

  it('offers no project settings for a folder whose discussions are all archived', async () => {
    conversation.projectFolders!.mockResolvedValue({ active: [THERE], archived: [HERE] });
    const shell = await mountShell();

    expect(shell.find('.working-directory-settings').exists()).toBe(false);
    expect(shell.find('.working-directory-change').exists()).toBe(true);
  });

  it('offers no project settings without a folder', async () => {
    useSettingsStore().config = { ...DEFAULT_CONFIG, workingDirectory: '' };
    const shell = await mountShell();

    expect(shell.find('.working-directory-settings').exists()).toBe(false);
    expect(shell.find('.working-directory-change').text()).toBe('No directory selected');
  });
});
