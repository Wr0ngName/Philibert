/**
 * The completion-notification choice in Settings: when a desktop notification
 * says Claude has finished — once everything is done, or at each reply and
 * each background task.
 *
 * `window.electron` is the process boundary, so it is what is mocked; the
 * settings store runs for real. The modal and the panels beside this one are
 * stubbed: this is about the notification section and what Save sends.
 */

import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineComponent, h } from 'vue';

import { DEFAULT_CONFIG } from '@shared/types';

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

function choices(wrapper: ReturnType<typeof mountPanel>) {
  return wrapper.findAll('[role="radiogroup"][aria-label="When to notify that Claude has finished"] [role="radio"]');
}

function chosen(wrapper: ReturnType<typeof mountPanel>): string[] {
  return choices(wrapper)
    .filter((c) => c.attributes('aria-checked') === 'true')
    .map((c) => c.find('.font-medium').text());
}

async function save(wrapper: ReturnType<typeof mountPanel>): Promise<void> {
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
    speech: { getAvailability: async () => ({ available: false, downloadedModels: [] }) },
  };
  useSettingsStore().config = { ...DEFAULT_CONFIG };
});

describe('completion notifications', () => {
  it('starts on "When everything is done"', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    expect(chosen(wrapper)).toEqual(['When everything is done']);
  });

  it('saves "Each reply and task" when chosen', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    await choices(wrapper)[1].trigger('click');
    await save(wrapper);

    expect(configApi.set).toHaveBeenCalledWith({ completionNotifications: 'each' });
    expect(useSettingsStore().config.completionNotifications).toBe('each');
  });

  it('shows the saved choice when opened again', async () => {
    useSettingsStore().config.completionNotifications = 'each';
    const wrapper = mountPanel();
    await flushPromises();

    expect(chosen(wrapper)).toEqual(['Each reply and task']);
  });

  it('is not offered while desktop notifications are off', async () => {
    useSettingsStore().config.enableNotifications = false;
    const wrapper = mountPanel();
    await flushPromises();

    expect(choices(wrapper)).toHaveLength(0);
  });
});
