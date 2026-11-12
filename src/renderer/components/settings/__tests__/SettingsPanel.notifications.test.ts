/**
 * The completion-notification choice in Settings: when a desktop notification
 * says Claude has finished — once everything is done, or at each reply and
 * each background task.
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
  fakeElectron({
    config: configApi,
  });
  useSettingsStore().config = { ...DEFAULT_CONFIG };
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
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
