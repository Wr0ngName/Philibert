/**
 * Settings in tabs: one page shown at a time, the keyboard moving between
 * them, a command opening the dialog at the tab it wants, About read only
 * once its tab is shown — and the archive setting, a switch and a slider
 * from a week to a year.
 *
 * The dialog is real; only the preload API is faked (support/settings-boundary).
 */

import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { DEFAULT_CONFIG } from '@shared/types';

import { useSettingsStore } from '../../../stores/settings';
import { useUiStore } from '../../../stores/ui';
import AuthForm from '../../shared/AuthForm.vue';

import { ABOUT, fakeElectron, mountSettings } from './support/settings-boundary';

const configApi = { set: vi.fn() };
const getInfo = vi.fn();


function mountPanel(open = true) {
  return mountSettings(open);
}

type Panel = ReturnType<typeof mountPanel>;

const tabs = (wrapper: Panel) => wrapper.findAll('[role="tab"]');
const selected = (wrapper: Panel) =>
  tabs(wrapper).filter((t) => t.attributes('aria-selected') === 'true').map((t) => t.text());
/** The pages shown, by the name of the tab that labels each. */
const shownPages = (wrapper: Panel) =>
  wrapper
    .findAll('[role="tabpanel"]')
    .filter((p) => p.isVisible())
    .map((p) => wrapper.find(`#${p.attributes('aria-labelledby')}`).text());

async function showTab(wrapper: Panel, name: string): Promise<void> {
  await tabs(wrapper).find((t) => t.text() === name)!.trigger('click');
  await flushPromises();
}

async function press(wrapper: Panel, label: string): Promise<void> {
  const button = wrapper.findAll('button').find((b) => b.text() === label);
  if (!button) throw new Error(`no ${label} button`);
  await button.trigger('click');
  await flushPromises();
}

let wrapper: Panel | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  configApi.set.mockResolvedValue(undefined);
  getInfo.mockResolvedValue(ABOUT);
  fakeElectron({ config: configApi, about: { getInfo } });
  useSettingsStore().config = { ...DEFAULT_CONFIG };
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('settings tabs', () => {
  // Asked for: the SDK / channel selector belongs with the advanced settings.
  it('has the execution mode, for a Pro/Max sign-in, in Advanced rather than Account', async () => {
    // Signed in with a subscription: what the selector is offered for.
    fakeElectron({
      config: configApi,
      about: { getInfo },
      auth: { getStatus: vi.fn().mockResolvedValue({ method: 'oauth', isAuthenticated: true }) },
    });
    wrapper = mountPanel();
    await flushPromises();

    const selector = () => wrapper!.find('.settings-execution-mode');
    expect(selector().exists()).toBe(true);
    expect(selector().isVisible(), 'shown on the Account page').toBe(false);

    await showTab(wrapper, 'Advanced');
    expect(selector().isVisible()).toBe(true);
    expect(selector().text()).toContain('Execution Mode');
    expect(wrapper.find(`#${'settings-page-advanced'}`).find('.settings-execution-mode').exists()).toBe(true);
  });

  it('lists its tabs and shows one page at a time, the account first', async () => {
    wrapper = mountPanel();
    await flushPromises();

    expect(tabs(wrapper).map((t) => t.text())).toEqual([
      'Account', 'Appearance', 'Discussions', 'Tools', 'Project', 'Advanced', 'About',
    ]);
    expect(selected(wrapper)).toEqual(['Account']);
    expect(shownPages(wrapper)).toEqual(['Account']);
    expect(wrapper.findComponent(AuthForm).isVisible()).toBe(true);

    await showTab(wrapper, 'Appearance');
    expect(selected(wrapper)).toEqual(['Appearance']);
    expect(shownPages(wrapper)).toEqual(['Appearance']);
    expect(wrapper.find('#font-size').isVisible()).toBe(true);
    expect(wrapper.findComponent(AuthForm).isVisible()).toBe(false);
  });

  it('moves between tabs with the arrow keys, Home and End, wrapping around', async () => {
    wrapper = mountPanel();
    await flushPromises();
    const key = async (name: string) => {
      await wrapper!.find('[role="tab"][aria-selected="true"]').trigger('keydown', { key: name });
      await flushPromises();
    };

    await key('ArrowDown');
    expect(selected(wrapper)).toEqual(['Appearance']);
    expect(document.activeElement?.textContent?.trim()).toBe('Appearance');
    await key('End');
    expect(selected(wrapper)).toEqual(['About']);
    await key('ArrowDown');
    expect(selected(wrapper)).toEqual(['Account']);
    await key('ArrowUp');
    expect(selected(wrapper)).toEqual(['About']);
    await key('Home');
    expect(selected(wrapper)).toEqual(['Account']);
    // Only the selected tab is in the tab order.
    expect(tabs(wrapper).map((t) => t.attributes('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1', '-1', '-1']);
  });

  it('opens at the tab a command asked for, once', async () => {
    const ui = useUiStore();
    wrapper = mountPanel(false);
    await flushPromises();

    ui.openSettings('tools');
    await wrapper.setProps({ open: true });
    await flushPromises();
    expect(selected(wrapper)).toEqual(['Tools']);
    expect(ui.pendingSettingsTab).toBeNull();

    // Reopened plainly, it stays where it was left.
    await showTab(wrapper, 'Advanced');
    await wrapper.setProps({ open: false });
    ui.openSettings();
    await wrapper.setProps({ open: true });
    await flushPromises();
    expect(selected(wrapper)).toEqual(['Advanced']);
  });

  it('reads the installation details only once About is shown, and again each time', async () => {
    wrapper = mountPanel();
    await flushPromises();
    expect(getInfo).not.toHaveBeenCalled();

    await showTab(wrapper, 'About');
    expect(getInfo).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('Claude Code CLI');
    expect(wrapper.text()).toContain('2.1.280');

    await showTab(wrapper, 'Account');
    await showTab(wrapper, 'About');
    expect(getInfo).toHaveBeenCalledTimes(2);
  });

  it('copies the installation details from About', async () => {
    wrapper = mountPanel();
    await flushPromises();
    await showTab(wrapper, 'About');

    await press(wrapper, 'Copy details');

    const writeText = (window as unknown as { electron: { clipboard: { writeText: ReturnType<typeof vi.fn> } } })
      .electron.clipboard.writeText;
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('Claude Code CLI: 2.1.280');
    expect(writeText.mock.calls[0][0]).toContain('License: MIT');
    expect(wrapper.text()).toContain('Copied');
  });
});

describe('archiving inactive discussions', () => {
  const archiveSwitch = (wrapper: Panel) =>
    wrapper.find('[role="switch"][aria-label="Toggle archiving inactive discussions"]');
  const slider = (wrapper: Panel) => wrapper.find<HTMLInputElement>('#auto-archive-after');

  async function slideTo(wrapper: Panel, stop: number): Promise<void> {
    await slider(wrapper).setValue(String(stop));
    await flushPromises();
  }

  it('is on at a month by default, the slider running from a week to a year', async () => {
    wrapper = mountPanel();
    await flushPromises();
    await showTab(wrapper, 'Discussions');

    expect(archiveSwitch(wrapper).attributes('aria-checked')).toBe('true');
    expect(slider(wrapper).attributes('aria-valuetext')).toBe('1 month');
    expect(slider(wrapper).attributes('min')).toBe('0');
    expect(slider(wrapper).attributes('max')).toBe('6');
    expect(wrapper.text()).toContain('After 1 month without a message');
    const ends = slider(wrapper).element.parentElement!.querySelectorAll('.justify-between span');
    expect([...ends].map((e) => e.textContent)).toEqual(['1 week', '1 year']);
  });

  it('saves the delay the slider is set to', async () => {
    wrapper = mountPanel();
    await flushPromises();
    await showTab(wrapper, 'Discussions');

    await slideTo(wrapper, 6);
    expect(wrapper.text()).toContain('After 1 year without a message');
    await press(wrapper, 'Save Changes');

    expect(configApi.set).toHaveBeenCalledWith({ autoArchiveDays: 365 });
    expect(useSettingsStore().config.autoArchiveDays).toBe(365);
  });

  it('saves never when switched off, and comes back to the delay set before when switched on', async () => {
    useSettingsStore().config.autoArchiveDays = 14;
    wrapper = mountPanel();
    await flushPromises();
    await showTab(wrapper, 'Discussions');
    expect(slider(wrapper).attributes('aria-valuetext')).toBe('2 weeks');

    await archiveSwitch(wrapper).trigger('click');
    expect(archiveSwitch(wrapper).attributes('aria-checked')).toBe('false');
    expect(slider(wrapper).exists()).toBe(false);

    await archiveSwitch(wrapper).trigger('click');
    expect(slider(wrapper).attributes('aria-valuetext')).toBe('2 weeks');

    await archiveSwitch(wrapper).trigger('click');
    await press(wrapper, 'Save Changes');
    expect(configApi.set).toHaveBeenCalledWith({ autoArchiveDays: 0 });
  });

  it('turned on from never, starts at a month', async () => {
    useSettingsStore().config.autoArchiveDays = 0;
    wrapper = mountPanel();
    await flushPromises();
    await showTab(wrapper, 'Discussions');
    expect(archiveSwitch(wrapper).attributes('aria-checked')).toBe('false');

    await archiveSwitch(wrapper).trigger('click');
    expect(slider(wrapper).attributes('aria-valuetext')).toBe('1 month');
  });

  it('leaves the setting as it was on Cancel', async () => {
    wrapper = mountPanel();
    await flushPromises();
    await showTab(wrapper, 'Discussions');

    await slideTo(wrapper, 0);
    expect(slider(wrapper).attributes('aria-valuetext')).toBe('1 week');
    await press(wrapper, 'Cancel');

    expect(configApi.set).not.toHaveBeenCalledWith({ autoArchiveDays: 7 });
    expect(useSettingsStore().config.autoArchiveDays).toBe(30);
    expect(slider(wrapper).attributes('aria-valuetext')).toBe('1 month');
  });
});
