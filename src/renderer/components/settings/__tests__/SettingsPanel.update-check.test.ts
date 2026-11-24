/**
 * Checking for an update from the About page: the app checks by itself when
 * it starts and every day, and a button there checks now, saying what was
 * found — an update (which the update banner offers), none, one already on
 * its way, or why none could be found.
 *
 * The dialog is real; only the preload API is faked (support/settings-boundary).
 */

import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, type UpdateCheckResult } from '@shared/types';

import { useSettingsStore } from '../../../stores/settings';

import { fakeElectron, mountSettings } from './support/settings-boundary';

const check = vi.fn<() => Promise<UpdateCheckResult>>();
let wrapper: ReturnType<typeof mountSettings> | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  fakeElectron({ update: { check } });
  useSettingsStore().config = { ...DEFAULT_CONFIG };
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

async function onAbout(): Promise<NonNullable<typeof wrapper>> {
  wrapper = mountSettings();
  await flushPromises();
  await wrapper.findAll('[role="tab"]').find((tab) => tab.text() === 'About')!.trigger('click');
  await flushPromises();
  return wrapper;
}

const button = () => wrapper!.find('[data-testid="check-for-updates"]');
const said = () => {
  const result = wrapper!.find('[data-testid="update-check-result"]');
  return result.exists() ? result.text().replace(/\s+/g, ' ') : null;
};

describe('checking for an update from About', () => {
  it('says the app checks by itself, and checks only when asked', async () => {
    await onAbout();

    expect(wrapper!.find('[data-testid="about-updates"]').text()).toContain('Philibert checks for updates when it starts, then every day.');
    expect(check).not.toHaveBeenCalled();
    expect(said()).toBeNull();
  });

  it.each([
    [{ status: 'available', update: { version: '0.33.0' } }, 'Version 0.33.0 is available: the banner at the top of the window downloads it.'],
    [{ status: 'up-to-date', latestVersion: '0.32.2' }, 'Philibert is up to date (newest release: 0.32.2).'],
    [{ status: 'pending', version: '0.33.0', downloaded: false }, 'Version 0.33.0 is downloading.'],
    [{ status: 'pending', version: '0.33.0', downloaded: true }, 'Version 0.33.0 is downloaded: the banner at the top of the window installs it.'],
    [{ status: 'failed', reason: 'no-release' }, 'No release was found on your update channel.'],
    [{ status: 'failed', reason: 'unsupported-install', version: '0.33.0' }, 'Version 0.33.0 is out, but this installation cannot update itself: download it from the repository\'s releases.'],
    [{ status: 'failed', reason: 'no-feed', version: '0.33.0' }, 'Version 0.33.0 is out, but has no update for this platform yet.'],
    [{ status: 'failed', reason: 'error', message: 'net::ERR_CONNECTION_RESET' }, 'Could not check: net::ERR_CONNECTION_RESET.'],
  ] as [UpdateCheckResult, string][])('says what the check found: %o', async (found, text) => {
    check.mockResolvedValue(found);
    await onAbout();

    await button().trigger('click');
    await flushPromises();

    expect(check).toHaveBeenCalledTimes(1);
    expect(said()).toBe(text);
  });

  it('cannot be asked again while it checks', async () => {
    let answer!: (result: UpdateCheckResult) => void;
    check.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    await onAbout();

    await button().trigger('click');
    await flushPromises();

    expect(button().attributes('disabled')).toBeDefined();
    expect(button().text()).toBe('Checking…');
    answer({ status: 'up-to-date', latestVersion: '0.32.2' });
    await flushPromises();
    expect(button().attributes('disabled')).toBeUndefined();
    expect(button().text()).toBe('Check for updates');
  });

  it('says why when the check could not be asked for at all', async () => {
    check.mockRejectedValue(new Error('UpdateService is not available'));
    await onAbout();

    await button().trigger('click');
    await flushPromises();

    expect(said()).toBe('Could not check: UpdateService is not available');
  });
});
