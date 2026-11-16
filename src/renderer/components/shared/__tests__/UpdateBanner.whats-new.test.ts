// @vitest-environment jsdom
/**
 * What an update changes, shown in the banner that offers it, so it can be
 * planned: the release's CHANGELOG.md section, carried by the update feed
 * as electron-updater's releaseNotes. `window.electron` is the process
 * boundary, so it is what is stubbed.
 *
 * Under jsdom: the notes are bound with v-html, and DOMPurify does not
 * sanitize inside happy-dom (see utils/__tests__/markdown.sanitize.test.ts).
 */

import { flushPromises, mount } from '@vue/test-utils';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import UpdateBanner from '../UpdateBanner.vue';

interface Offered { version: string; releaseNotes?: string }

const NOTES = '- **Usage limits are waited out** for up to a week.\n- <img src=x onerror="alert(1)">Tidier history.';

let announce: { available?: (info: Offered) => void; downloaded?: () => void } = {};
let wrapper: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  announce = {};
  (window as unknown as { electron: unknown }).electron = {
    update: {
      onAvailable: (callback: (info: Offered) => void) => { announce.available = callback; return () => undefined; },
      onProgress: () => () => undefined,
      onDownloaded: (callback: () => void) => { announce.downloaded = callback; return () => undefined; },
      download: vi.fn(async () => undefined),
      install: vi.fn(),
    },
    clipboard: { writeText: vi.fn() },
  };
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

async function offered(info: Offered) {
  wrapper = mount(UpdateBanner);
  announce.available!(info);
  await flushPromises();
  return wrapper;
}

function toggle(banner: ReturnType<typeof mount>) {
  return banner.find('.update-notes-toggle');
}

describe("the update banner's what's new", () => {
  it('shows the notes on asking, and hides them again', async () => {
    const banner = await offered({ version: '0.31.0', releaseNotes: NOTES });
    expect(banner.find('.update-notes').exists()).toBe(false);

    await toggle(banner).trigger('click');
    const notes = banner.find('.update-notes');
    expect(notes.find('strong').text()).toBe('Usage limits are waited out');
    expect(notes.findAll('li')).toHaveLength(2);
    expect(toggle(banner).attributes('aria-expanded')).toBe('true');

    await toggle(banner).trigger('click');
    expect(banner.find('.update-notes').exists()).toBe(false);
  });

  it('renders them sanitized, as a message is', async () => {
    const banner = await offered({ version: '0.31.0', releaseNotes: NOTES });
    await toggle(banner).trigger('click');

    expect(banner.find('.update-notes').html()).not.toContain('onerror');
    expect(banner.find('.update-notes').text()).toContain('Tidier history.');
  });

  it('is still there once the update is downloaded, to pick when to restart', async () => {
    const banner = await offered({ version: '0.31.0', releaseNotes: NOTES });
    announce.downloaded!();
    await flushPromises();

    expect(banner.text()).toContain('Update v0.31.0 ready to install');
    await toggle(banner).trigger('click');
    expect(banner.find('.update-notes').exists()).toBe(true);
  });

  it('is not offered for a release without notes', async () => {
    const banner = await offered({ version: '0.30.1' });
    expect(toggle(banner).exists()).toBe(false);
  });

  it('starts closed again for the next update offered', async () => {
    const banner = await offered({ version: '0.31.0', releaseNotes: NOTES });
    await toggle(banner).trigger('click');

    announce.available!({ version: '0.31.1', releaseNotes: '- Another fix.' });
    await flushPromises();
    expect(banner.find('.update-notes').exists()).toBe(false);
  });
});
