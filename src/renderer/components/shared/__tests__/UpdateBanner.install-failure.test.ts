/**
 * "Restart now" when the update cannot be installed.
 *
 * Reported: on Linux, the button did nothing — the installer's password
 * prompt could not be shown, and the failure reached nobody. The banner now
 * says why, and how to install the downloaded package by hand.
 * `window.electron` is the process boundary, so it is what is stubbed.
 */

import { flushPromises, mount } from '@vue/test-utils';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { UpdateInstallResult } from '@shared/types';

import UpdateBanner from '../UpdateBanner.vue';

const DEB = '/home/u/.cache/Philibert/pending/philibert_0.25.12_amd64.deb';
const FAILED: UpdateInstallResult = {
  installed: false,
  error: 'Command pkexec exited with code 127',
  downloadedFile: DEB,
  installCommand: `sudo apt install '${DEB}'`,
  releaseUrl: 'https://dev.web.wr0ng.name/wrongname/philibert/-/releases/v0.25.12',
};

let announce: { available?: (info: { version: string }) => void; downloaded?: () => void } = {};
const install = vi.fn<() => Promise<UpdateInstallResult>>();
const writeText = vi.fn(async () => undefined);
let wrapper: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  announce = {};
  install.mockReset();
  writeText.mockClear();
  (window as unknown as { electron: unknown }).electron = {
    update: {
      onAvailable: (callback: (info: { version: string }) => void) => { announce.available = callback; return () => undefined; },
      onProgress: () => () => undefined,
      onDownloaded: (callback: () => void) => { announce.downloaded = callback; return () => undefined; },
      download: vi.fn(async () => undefined),
      install,
    },
    clipboard: { writeText },
  };
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

/** The banner with v0.25.12 downloaded, as the main process announces it. */
async function downloadedBanner() {
  wrapper = mount(UpdateBanner);
  announce.available!({ version: '0.25.12' });
  announce.downloaded!();
  await flushPromises();
  return wrapper;
}

function restartNow(banner: ReturnType<typeof mount>) {
  return banner.findAll('button').find((b) => b.text() === 'Restart Now')!;
}

describe('installing the downloaded update', () => {
  it('says why it could not, and gives the command and the release page', async () => {
    install.mockResolvedValue(FAILED);
    const banner = await downloadedBanner();

    await restartNow(banner).trigger('click');
    await flushPromises();

    expect(banner.text()).toContain('Update v0.25.12 could not be installed: Command pkexec exited with code 127');
    expect(banner.find('.update-install-command').text()).toBe(`sudo apt install '${DEB}'`);
    expect(banner.find('a').attributes('href')).toBe(FAILED.releaseUrl);
    expect(banner.findAll('button').some((b) => b.text() === 'Restart Now')).toBe(false);
  });

  it('copies the command', async () => {
    install.mockResolvedValue(FAILED);
    const banner = await downloadedBanner();
    await restartNow(banner).trigger('click');
    await flushPromises();

    await banner.findAll('button').find((b) => b.text() === 'Copy')!.trigger('click');
    await flushPromises();

    expect(writeText).toHaveBeenCalledWith(`sudo apt install '${DEB}'`);
    expect(banner.text()).toContain('Copied');
  });

  it('keeps offering to restart while the install goes ahead', async () => {
    install.mockResolvedValue({ installed: true });
    const banner = await downloadedBanner();

    await restartNow(banner).trigger('click');
    await flushPromises();

    expect(banner.find('.update-install-failure').exists()).toBe(false);
    expect(restartNow(banner).exists()).toBe(true);
  });
});
