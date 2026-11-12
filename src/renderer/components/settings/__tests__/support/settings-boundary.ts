/**
 * The settings dialog as tests mount it: every component real, with only
 * the process boundary faked — `window.electron`, the preload API — and
 * Vue's own Teleport, so the dialog renders where the test can reach it.
 *
 * `fakeElectron` answers every call the dialog's pages make, with a quiet
 * default each test can replace: a whole API (`config: configApi`), or one
 * call of one (`claude: { getSessionRetention }`).
 */

import { mount } from '@vue/test-utils';
import { vi } from 'vitest';

import type { AboutInfo, AuthStatus, GlobalTools, ProjectTools } from '@shared/types';

import SettingsPanel from '../../SettingsPanel.vue';

export const ABOUT: AboutInfo = {
  appVersion: '0.25.5',
  agentSdkVersion: '0.3.280',
  claudeCodeVersion: '2.1.280',
  whisperVersion: 'v1.9.5',
  whisperBinaryPath: null,
  electronVersion: '42.0.1',
  chromeVersion: '140',
  nodeVersion: '22.0.0',
  platform: 'linux',
  arch: 'x64',
  bundleType: null,
  repositoryUrl: null,
  license: 'MIT',
  userDataPath: '/home/u/.config/Philibert',
  logPath: '/home/u/.config/Philibert/logs/main.log',
};

const SIGNED_OUT: AuthStatus = { isAuthenticated: false, method: 'none' };
const NO_TOOLS: GlobalTools = { statuses: [], userServers: [], offEverywhere: [] };
const NO_PROJECT_TOOLS: ProjectTools = { statuses: [], userServers: [], offEverywhere: [] };

type Api = Record<string, Record<string, unknown>>;

function defaults(): Api {
  return {
    config: { get: vi.fn(), set: vi.fn().mockResolvedValue(undefined) },
    speech: { getAvailability: vi.fn().mockResolvedValue({ available: false, downloadedModels: [] }) },
    about: { getInfo: vi.fn().mockResolvedValue(ABOUT) },
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    auth: {
      getStatus: vi.fn().mockResolvedValue(SIGNED_OUT),
      getAccount: vi.fn().mockResolvedValue(null),
      startOAuth: vi.fn(),
      completeOAuth: vi.fn(),
      cancelOAuth: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
    },
    claude: {
      getSessionRetention: vi.fn().mockResolvedValue({ status: 'default', days: 30 }),
      setSessionRetention: vi.fn(async (days: number) => ({ status: 'set', days })),
      getProjectPermissions: vi.fn().mockResolvedValue([]),
      revokeProjectPermission: vi.fn().mockResolvedValue([]),
    },
    mcp: {
      list: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      remove: vi.fn(),
      setEnabled: vi.fn(),
      checkCommand: vi.fn().mockResolvedValue({ ok: true }),
      getRuntimeInfo: vi.fn().mockResolvedValue({ platform: 'linux', bundledNodePath: null }),
      pickExecutable: vi.fn(),
      pickFile: vi.fn(),
      globalTools: vi.fn().mockResolvedValue(NO_TOOLS),
      setOffEverywhere: vi.fn(),
      saveUserServer: vi.fn(),
      removeUserServer: vi.fn(),
      projectTools: vi.fn().mockResolvedValue(NO_PROJECT_TOOLS),
      setEnabledInProject: vi.fn(),
      authorizeConnector: vi.fn().mockResolvedValue(undefined),
    },
  };
}

/** Install the fake preload API, each of `overrides` laid over the defaults. */
export function fakeElectron(overrides: Api = {}): Api {
  const api = defaults();
  for (const [key, calls] of Object.entries(overrides)) api[key] = { ...api[key], ...calls };
  (window as unknown as { electron: unknown }).electron = api;
  return api;
}

/** Mount the real settings dialog, attached so focus and visibility behave as in the app. */
export function mountSettings(open = true) {
  return mount(SettingsPanel, {
    props: { open },
    attachTo: document.body,
    global: { stubs: { teleport: true } },
  });
}
