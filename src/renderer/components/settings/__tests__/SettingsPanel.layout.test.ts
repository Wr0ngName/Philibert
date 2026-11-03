/**
 * The Layout choice in Settings: where the sidebars sit beside the
 * discussion. Saved with the other settings, left as it was on Cancel.
 *
 * `window.electron` is the process boundary, so it is what is mocked; the
 * settings store runs for real.
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

/** The sign-in form, with the methods the panel calls on it. */
const AuthFormStub = {
  template: '<div />',
  methods: { resetState: () => undefined, refreshAuthStatus: async () => undefined },
};

function mountPanel() {
  return mount(SettingsPanel, {
    props: { open: true },
    global: {
      stubs: { Modal: ModalStub, AuthForm: AuthFormStub, McpServersPanel: true, Icon: true },
    },
  });
}

function layouts(wrapper: ReturnType<typeof mountPanel>) {
  return wrapper.findAll('[role="radiogroup"][aria-labelledby="sidebar-layout-label"] [role="radio"]');
}

function chosen(wrapper: ReturnType<typeof mountPanel>): string[] {
  return layouts(wrapper)
    .filter((c) => c.attributes('aria-checked') === 'true')
    .map((c) => c.find('.font-medium').text());
}

async function press(wrapper: ReturnType<typeof mountPanel>, label: string): Promise<void> {
  const button = wrapper.findAll('button').find((b) => b.text() === label);
  if (!button) throw new Error(`no ${label} button`);
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

describe('sidebar layout', () => {
  it('offers the three layouts, the discussion in the middle chosen by default', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    expect(layouts(wrapper).map((c) => c.find('.font-medium').text())).toEqual([
      'Both left',
      'Either side',
      'Both right',
    ]);
    expect(chosen(wrapper)).toEqual(['Either side']);
  });

  it('saves the layout chosen', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    await layouts(wrapper)[2].trigger('click');
    await press(wrapper, 'Save Changes');
    expect(configApi.set).toHaveBeenCalledWith({ sidebarLayout: 'right' });
    expect(useSettingsStore().config.sidebarLayout).toBe('right');
  });

  it('leaves the layout as it was on Cancel', async () => {
    useSettingsStore().config.sidebarLayout = 'left';
    const wrapper = mountPanel();
    await flushPromises();
    expect(chosen(wrapper)).toEqual(['Both left']);
    await layouts(wrapper)[1].trigger('click');
    await press(wrapper, 'Cancel');
    expect(configApi.set).not.toHaveBeenCalledWith({ sidebarLayout: 'split' });
    expect(useSettingsStore().config.sidebarLayout).toBe('left');
    expect(chosen(wrapper)).toEqual(['Both left']);
  });
});
