/**
 * How far ahead a usage limit's reset may be and still be waited for, in
 * Settings: a day to a week, three days unless set, and saved with the rest.
 *
 * `window.electron` is the process boundary, so it is what is mocked; the
 * settings store runs for real. The modal and the panels beside this one are
 * stubbed.
 */

import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineComponent, h } from 'vue';

import { DEFAULT_CONFIG, USAGE_LIMIT_WAIT_DAYS } from '@shared/types';

import { useSettingsStore } from '../../../stores/settings';
import SettingsPanel from '../SettingsPanel.vue';

const configApi = { set: vi.fn() };

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

const slider = (wrapper: Panel) => wrapper.find('#usage-limit-wait');
const label = (wrapper: Panel) => wrapper.find('label[for="usage-limit-wait"]').text();

async function waitUpTo(wrapper: Panel, days: number): Promise<void> {
  await slider(wrapper).setValue(String((USAGE_LIMIT_WAIT_DAYS as readonly number[]).indexOf(days)));
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
  (window as unknown as { electron: unknown }).electron = {
    config: configApi,
    claude: { getSessionRetention: async () => ({ status: 'default', days: 30 }), setSessionRetention: vi.fn() },
    speech: { getAvailability: async () => ({ available: false, downloadedModels: [] }) },
  };
  useSettingsStore().config = { ...DEFAULT_CONFIG };
});

describe('waiting for a usage limit to reset', () => {
  it('waits three days ahead unless set, from a day to a week', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    expect(label(wrapper)).toBe('Wait for a reset up to 3 days ahead');
    expect(slider(wrapper).attributes('max')).toBe(String(USAGE_LIMIT_WAIT_DAYS.length - 1));
    expect(wrapper.find('.usage-limit-wait').text()).toContain('1 day');
    expect(wrapper.find('.usage-limit-wait').text()).toContain('1 week');
  });

  it('saves the days chosen', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    await waitUpTo(wrapper, 7);
    expect(label(wrapper)).toBe('Wait for a reset up to 1 week ahead');
    await save(wrapper);

    expect(configApi.set).toHaveBeenCalledWith({ usageLimitWaitDays: 7 });
    expect(useSettingsStore().config.usageLimitWaitDays).toBe(7);
  });

  it('shows what is saved', async () => {
    useSettingsStore().config = { ...DEFAULT_CONFIG, usageLimitWaitDays: 5 };
    const wrapper = mountPanel();
    await flushPromises();
    expect(label(wrapper)).toBe('Wait for a reset up to 5 days ahead');

    await waitUpTo(wrapper, 1);
    expect(label(wrapper)).toBe('Wait for a reset up to 1 day ahead');
  });

  it('goes no further than the archive delay', async () => {
    // Every archive delay on offer is a week or more today, so the wait is
    // never cut short — its rule is tested on its own (maxUsageLimitWaitDays).
    useSettingsStore().config = { ...DEFAULT_CONFIG, autoArchiveDays: 7, usageLimitWaitDays: 7 };
    const wrapper = mountPanel();
    await flushPromises();

    await waitUpTo(wrapper, 7);
    expect(label(wrapper)).toBe('Wait for a reset up to 1 week ahead');
    expect(wrapper.find('.usage-limit-wait-capped').exists()).toBe(false);
  });
});
