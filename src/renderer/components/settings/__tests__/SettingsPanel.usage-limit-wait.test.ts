/**
 * How far ahead a usage limit's reset may be and still be waited for, in
 * Settings: a day to a week, three days unless set, and saved with the rest.
 *
 * The dialog is real; only the preload API is faked (support/settings-boundary).
 */

import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { DEFAULT_CONFIG, USAGE_LIMIT_WAIT_DAYS } from '@shared/types';

import { useSettingsStore } from '../../../stores/settings';

import { fakeElectron, mountSettings } from './support/settings-boundary';

const configApi = { set: vi.fn() };

type Panel = ReturnType<typeof mountSettings>;
let wrapper: Panel | null = null;

function mountPanel(): Panel {
  wrapper = mountSettings();
  return wrapper;
}

const slider = (panel: Panel) => panel.find('#usage-limit-wait');
const label = (panel: Panel) => panel.find('label[for="usage-limit-wait"]').text();

async function waitUpTo(panel: Panel, days: number): Promise<void> {
  await slider(panel).setValue(String((USAGE_LIMIT_WAIT_DAYS as readonly number[]).indexOf(days)));
}

async function click(panel: Panel, text: string): Promise<void> {
  const button = panel.findAll('button').find((b) => b.text() === text);
  if (!button) throw new Error(`no ${text} button`);
  await button.trigger('click');
  await flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  configApi.set.mockResolvedValue(undefined);
  fakeElectron({ config: configApi });
  useSettingsStore().config = { ...DEFAULT_CONFIG };
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('waiting for a usage limit to reset', () => {
  it('waits three days ahead unless set, from a day to a week', async () => {
    const panel = mountPanel();
    await flushPromises();

    expect(label(panel)).toBe('Wait for a reset up to 3 days ahead');
    expect(slider(panel).attributes('max')).toBe(String(USAGE_LIMIT_WAIT_DAYS.length - 1));
    expect(panel.find('.usage-limit-wait').text()).toContain('1 day');
    expect(panel.find('.usage-limit-wait').text()).toContain('1 week');
  });

  it('saves the days chosen', async () => {
    const panel = mountPanel();
    await flushPromises();

    await waitUpTo(panel, 7);
    expect(label(panel)).toBe('Wait for a reset up to 1 week ahead');
    await click(panel, 'Save Changes');

    expect(configApi.set).toHaveBeenCalledWith({ usageLimitWaitDays: 7 });
    expect(useSettingsStore().config.usageLimitWaitDays).toBe(7);
  });

  it('shows what is saved, and goes back to it on cancel', async () => {
    useSettingsStore().config = { ...DEFAULT_CONFIG, usageLimitWaitDays: 5 };
    const panel = mountPanel();
    await flushPromises();
    expect(label(panel)).toBe('Wait for a reset up to 5 days ahead');

    await waitUpTo(panel, 1);
    expect(label(panel)).toBe('Wait for a reset up to 1 day ahead');
    await click(panel, 'Cancel');
    expect(label(panel)).toBe('Wait for a reset up to 5 days ahead');
    expect(configApi.set).not.toHaveBeenCalled();
  });

  it('goes no further than the archive delay', async () => {
    // Every archive delay on offer is a week or more today, so the wait is
    // never cut short — its rule is tested on its own (maxUsageLimitWaitDays).
    useSettingsStore().config = { ...DEFAULT_CONFIG, autoArchiveDays: 7, usageLimitWaitDays: 7 };
    const panel = mountPanel();
    await flushPromises();

    await waitUpTo(panel, 7);
    expect(label(panel)).toBe('Wait for a reset up to 1 week ahead');
    expect(panel.find('.usage-limit-wait-capped').exists()).toBe(false);
  });
});
