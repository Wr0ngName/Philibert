/**
 * The shell sandbox in Settings: whether new discussions start in it, and
 * the sites and folders it lets sandboxed commands reach — one a line,
 * what the sandbox would not take said and not saved.
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

type Panel = ReturnType<typeof mountSettings>;
let wrapper: Panel | null = null;

async function click(panel: Panel, text: string): Promise<void> {
  const button = panel.findAll('button').find((b) => b.text() === text);
  if (!button) throw new Error(`no ${text} button`);
  await button.trigger('click');
  await flushPromises();
}

const section = (panel: Panel) => panel.get('[data-testid="sandbox-settings"]');

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  configApi.set.mockResolvedValue(undefined);
  fakeElectron({ config: configApi });
  useSettingsStore().config = {
    ...DEFAULT_CONFIG,
    sandbox: { enabledByDefault: true, allowedDomains: ['example.com'], allowWrite: ['~/.npm'] },
  };
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('the shell sandbox in Settings', () => {
  it('shows what is saved, one entry a line', async () => {
    wrapper = mountSettings();
    await flushPromises();

    expect((wrapper.get('#sandbox-domains').element as HTMLTextAreaElement).value).toBe('example.com');
    expect((wrapper.get('#sandbox-write').element as HTMLTextAreaElement).value).toBe('~/.npm');
    expect(section(wrapper).text()).toContain('anywhere on this computer');
  });

  it('saves the default and the lists, leaving out what the sandbox would not take', async () => {
    wrapper = mountSettings();
    await flushPromises();

    await section(wrapper).get('button[role="switch"], input[type="checkbox"]').trigger('click');
    await wrapper.get('#sandbox-domains').setValue('example.com\n\n *.npmjs.org \nhttps://bad.example/x');
    await wrapper.get('#sandbox-write').setValue('~/.npm\nrelative/dir\n/srv/cache');
    expect(section(wrapper).text()).toContain('Not a host name, and not saved: https://bad.example/x');
    expect(section(wrapper).text()).toContain('Not an absolute path, and not saved: relative/dir');
    await click(wrapper, 'Save Changes');

    expect(configApi.set).toHaveBeenCalledWith({
      sandbox: { enabledByDefault: false, allowedDomains: ['example.com', '*.npmjs.org'], allowWrite: ['~/.npm', '/srv/cache'] },
    });
  });

  it('goes back to what is saved on cancel', async () => {
    wrapper = mountSettings();
    await flushPromises();

    await wrapper.get('#sandbox-domains').setValue('other.example');
    await click(wrapper, 'Cancel');

    expect(configApi.set).not.toHaveBeenCalledWith(expect.objectContaining({ sandbox: expect.anything() }));
    expect((wrapper.get('#sandbox-domains').element as HTMLTextAreaElement).value).toBe('example.com');
  });
});
