/**
 * The Layout choice in Settings: where the sidebars sit beside the
 * discussion. Saved with the other settings, left as it was on Cancel.
 *
 * The dialog is real; only the preload API is faked (support/settings-boundary).
 */

import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { DEFAULT_CONFIG } from '@shared/types';

import { useSettingsStore } from '../../../stores/settings';

import { fakeElectron, mountSettings } from './support/settings-boundary';

const configApi = { set: vi.fn() };

const mounted: ReturnType<typeof mountSettings>[] = [];

function mountPanel() {
  const wrapper = mountSettings();
  mounted.push(wrapper);
  return wrapper;
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
  fakeElectron({
    config: configApi,
  });
  useSettingsStore().config = { ...DEFAULT_CONFIG };
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
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
