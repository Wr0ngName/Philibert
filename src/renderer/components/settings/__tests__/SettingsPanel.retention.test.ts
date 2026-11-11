/**
 * How long Claude Code keeps sessions, in Settings beside archiving: read from
 * and written to Claude Code's own settings, and kept longer than archiving —
 * a discussion archived after its session is deleted could never be brought
 * back.
 *
 * `window.electron` is the process boundary, so it is what is mocked; the
 * settings store runs for real. The modal and the panels beside this one are
 * stubbed: this is about the archive section and what Save sends.
 */

import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineComponent, h } from 'vue';

import { DEFAULT_CONFIG, type SessionRetention } from '@shared/types';

import { useSettingsStore } from '../../../stores/settings';
import SettingsPanel from '../SettingsPanel.vue';

const configApi = { set: vi.fn() };
const claudeApi = {
  getSessionRetention: vi.fn<() => Promise<SessionRetention>>(),
  setSessionRetention: vi.fn<(days: number) => Promise<SessionRetention>>(),
};

/** Renders the modal's body and footer in place, so they can be clicked. */
const ModalStub = defineComponent({
  setup(_, { slots }) {
    return () => h('div', [slots.default?.(), slots.footer?.()]);
  },
});

function mountPanel() {
  return mount(SettingsPanel, {
    props: { open: true },
    global: {
      stubs: { Modal: ModalStub, AuthForm: true, McpServersPanel: true, Icon: true },
    },
  });
}
type Panel = ReturnType<typeof mountPanel>;

const ARCHIVE_STOPS = [7, 14, 30, 60, 90, 180, 365];
const RETENTION_STOPS = [7, 14, 30, 60, 90, 180, 365, 730, 3650];

const archiveSlider = (wrapper: Panel) => wrapper.find('#auto-archive-after');
const retentionSlider = (wrapper: Panel) => wrapper.find('#session-retention');
const retentionLabel = (wrapper: Panel) => wrapper.find('label[for="session-retention"]').text();
const archiveLabel = (wrapper: Panel) => wrapper.find('label[for="auto-archive-after"]').text();
const warning = (wrapper: Panel) => wrapper.find('.archive-outlives-sessions');

async function archiveAfter(wrapper: Panel, days: number): Promise<void> {
  await archiveSlider(wrapper).setValue(String(ARCHIVE_STOPS.indexOf(days)));
}

async function keepSessions(wrapper: Panel, days: number): Promise<void> {
  await retentionSlider(wrapper).setValue(String(RETENTION_STOPS.indexOf(days)));
}

async function save(wrapper: Panel): Promise<void> {
  const button = wrapper.findAll('button').find((b) => b.text() === 'Save Changes');
  if (!button) throw new Error('no Save Changes button');
  await button.trigger('click');
  await flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  configApi.set.mockResolvedValue(undefined);
  claudeApi.getSessionRetention.mockResolvedValue({ status: 'default', days: 30 });
  claudeApi.setSessionRetention.mockImplementation(async (days) => ({ status: 'set', days }));
  (window as unknown as { electron: unknown }).electron = {
    config: configApi,
    claude: claudeApi,
    speech: { getAvailability: async () => ({ available: false, downloadedModels: [] }) },
  };
  useSettingsStore().config = { ...DEFAULT_CONFIG, autoArchiveDays: 14 };
});

describe('keeping Claude sessions', () => {
  it("shows how long Claude Code keeps them, saying when it is Claude Code's default", async () => {
    const wrapper = mountPanel();
    await flushPromises();
    expect(retentionLabel(wrapper)).toBe("For 1 month (Claude Code's default)");

    claudeApi.getSessionRetention.mockResolvedValue({ status: 'set', days: 45 });
    const custom = mountPanel();
    await flushPromises();
    // A value set outside the app is a stop of its own.
    expect(retentionLabel(custom)).toBe('For 45 days');
  });

  it('writes the new retention to Claude Code on save, and nothing when it was not changed', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    await save(wrapper);
    expect(claudeApi.setSessionRetention).not.toHaveBeenCalled();

    const changed = mountPanel();
    await flushPromises();
    await keepSessions(changed, 365);
    await save(changed);
    expect(claudeApi.setSessionRetention).toHaveBeenCalledWith(365);
  });

  it('keeps sessions longer when archiving is moved to or past the retention', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    await archiveAfter(wrapper, 90);

    expect(retentionLabel(wrapper)).toBe('For 6 months');
    expect(warning(wrapper).exists()).toBe(false);
    await save(wrapper);
    expect(claudeApi.setSessionRetention).toHaveBeenCalledWith(180);
    expect(configApi.set).toHaveBeenCalledWith({ autoArchiveDays: 90 });
  });

  it('archives sooner when the retention is moved down to archiving — or not at all below a week', async () => {
    useSettingsStore().config.autoArchiveDays = 60;
    claudeApi.getSessionRetention.mockResolvedValue({ status: 'set', days: 365 });
    const wrapper = mountPanel();
    await flushPromises();

    await keepSessions(wrapper, 30);
    expect(archiveLabel(wrapper)).toBe('After 2 weeks without a message');

    await keepSessions(wrapper, 7);
    expect(archiveSlider(wrapper).exists()).toBe(false);
    await save(wrapper);
    expect(configApi.set).toHaveBeenCalledWith({ autoArchiveDays: 0 });
    expect(claudeApi.setSessionRetention).toHaveBeenCalledWith(7);
  });

  it('keeps sessions longer when archiving is turned on past the retention', async () => {
    useSettingsStore().config.autoArchiveDays = 0;
    claudeApi.getSessionRetention.mockResolvedValue({ status: 'set', days: 7 });
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.find('[aria-label="Toggle archiving inactive discussions"]').trigger('click');

    // Archiving comes back at the default, a month: sessions are kept past it.
    expect(archiveLabel(wrapper)).toBe('After 1 month without a message');
    expect(retentionLabel(wrapper)).toBe('For 2 months');
  });

  it('warns when the settings as found archive too late to bring anything back', async () => {
    useSettingsStore().config.autoArchiveDays = 30;
    const wrapper = mountPanel();
    await flushPromises();

    expect(warning(wrapper).text()).toContain('Discussions are archived after 1 month');

    await keepSessions(wrapper, 60);
    expect(warning(wrapper).exists()).toBe(false);
  });

  it("is not offered when Claude Code's settings cannot be read, and nothing is written there", async () => {
    claudeApi.getSessionRetention.mockResolvedValue({ status: 'unreadable' });
    useSettingsStore().config.autoArchiveDays = 365;
    const wrapper = mountPanel();
    await flushPromises();

    expect(wrapper.find('.retention-unreadable').exists()).toBe(true);
    expect(retentionSlider(wrapper).exists()).toBe(false);
    expect(warning(wrapper).exists()).toBe(false);
    await archiveAfter(wrapper, 7);
    await save(wrapper);
    expect(claudeApi.setSessionRetention).not.toHaveBeenCalled();
    expect(configApi.set).toHaveBeenCalledWith({ autoArchiveDays: 7 });
  });

  it('stays open on the reason, saving nothing, when Claude Code\'s settings cannot be written', async () => {
    claudeApi.setSessionRetention.mockRejectedValue(new Error('EACCES'));
    const wrapper = mountPanel();
    await flushPromises();

    await keepSessions(wrapper, 90);
    await archiveAfter(wrapper, 60);
    await save(wrapper);

    expect(wrapper.find('.retention-error').text()).toContain("could not be written");
    expect(wrapper.emitted('close')).toBeUndefined();
    expect(configApi.set).not.toHaveBeenCalled();
  });
});
