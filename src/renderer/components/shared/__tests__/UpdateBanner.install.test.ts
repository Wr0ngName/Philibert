/**
 * Restarting to install a downloaded update, from the banner. The main
 * process asks first when work is in flight that restarting would stop, as
 * quitting does (CloseGuard.prepareToQuitForUpdate): kept working, nothing
 * is installed, and the banner stays as it was, to restart later. A failed
 * install says why, with what to do by hand.
 *
 * The banner is real; only the preload API is faked.
 */

import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpdateInfo, UpdateInstallResult } from '@shared/types';

import UpdateBanner from '../UpdateBanner.vue';

const install = vi.fn<() => Promise<UpdateInstallResult>>();
let announce: (info: UpdateInfo) => void;
let downloaded: () => void;
let wrapper: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  (window as unknown as { electron: unknown }).electron = {
    update: {
      check: vi.fn(),
      download: vi.fn().mockResolvedValue(undefined),
      install,
      onAvailable: (callback: (info: UpdateInfo) => void) => { announce = callback; return () => {}; },
      onProgress: () => () => {},
      onDownloaded: (callback: () => void) => { downloaded = callback; return () => {}; },
    },
    clipboard: { writeText: vi.fn() },
  };
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

/** The banner, an update downloaded and ready to install. */
async function ready(): Promise<NonNullable<typeof wrapper>> {
  wrapper = mount(UpdateBanner, { global: { stubs: { teleport: true } } });
  announce({ version: '0.33.0' });
  downloaded();
  await flushPromises();
  return wrapper;
}

async function restartNow(): Promise<void> {
  const button = wrapper!.findAll('button').find((b) => b.text() === 'Restart Now');
  if (!button) throw new Error('no Restart Now button');
  await button.trigger('click');
  await flushPromises();
}

const text = () => wrapper!.text().replace(/\s+/g, ' ');

describe('restarting to install from the banner', () => {
  it('kept working when asked, stays ready to install, nothing said to have failed', async () => {
    install.mockResolvedValue({ installed: false, reason: 'kept-working' });
    await ready();

    await restartNow();

    expect(install).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Update v0.33.0 ready to install');
    expect(text()).not.toContain('could not be installed');
    expect(wrapper!.findAll('button').some((b) => b.text() === 'Restart Now')).toBe(true);
  });

  it('says why when the install failed, with the command to install it by hand', async () => {
    install.mockResolvedValue({
      installed: false,
      reason: 'failed',
      error: 'Command pkexec exited with code 127',
      downloadedFile: '/tmp/philibert.deb',
      installCommand: "sudo apt install '/tmp/philibert.deb'",
      releaseUrl: null,
    });
    await ready();

    await restartNow();

    expect(text()).toContain('Update v0.33.0 could not be installed: Command pkexec exited with code 127');
    expect(text()).toContain("sudo apt install '/tmp/philibert.deb'");
  });
});
