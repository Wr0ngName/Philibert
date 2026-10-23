/**
 * Tests for the active permissions dropdown: project-scoped entries from the
 * working directory's settings files are listed beside the session grants,
 * can be revoked when they live in the local file, and are re-read when the
 * file watcher reports a change to a project settings file.
 */

import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { FileChange, ProjectPermissionEntry, SessionPermissionEntry } from '@shared/types';

vi.mock('../../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { useChatStore } from '../../../stores/chat';
import { useConversationsStore } from '../../../stores/conversations';
import { useSettingsStore } from '../../../stores/settings';
import SessionPermissionsDropdown from '../SessionPermissionsDropdown.vue';

const PROJECT = '/home/user/project';

const LOCAL_RULE: ProjectPermissionEntry = {
  kind: 'rule', value: 'Bash(npm test)', toolName: 'Bash', ruleContent: 'npm test', source: 'local',
};
const SHARED_RULE: ProjectPermissionEntry = {
  kind: 'rule', value: 'Write', toolName: 'Write', source: 'shared',
};
const SESSION_GRANT: SessionPermissionEntry = {
  id: 'perm-1', toolName: 'WebSearch', description: 'Allow WebSearch for this session', grantedAt: 0,
};

let getProjectPermissions: ReturnType<typeof vi.fn>;
let revokeProjectPermission: ReturnType<typeof vi.fn>;
let emitFileChanges: (changes: FileChange[]) => void;

async function mountOpen() {
  const wrapper = mount(SessionPermissionsDropdown, {
    global: { stubs: { TransitionFade: { template: '<div><slot /></div>' } } },
  });
  await flushPromises();
  await wrapper.find('button').trigger('click');
  await flushPromises();
  return wrapper;
}

describe('SessionPermissionsDropdown project permissions', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    getProjectPermissions = vi.fn().mockResolvedValue([LOCAL_RULE, SHARED_RULE]);
    revokeProjectPermission = vi.fn().mockResolvedValue([SHARED_RULE]);
    (globalThis as unknown as { window: Record<string, unknown> }).window.electron = {
      claude: {
        getSessionPermissions: vi.fn().mockResolvedValue([SESSION_GRANT]),
        revokeSessionPermission: vi.fn(),
        getProjectPermissions,
        revokeProjectPermission,
      },
      files: {
        onChange: vi.fn((callback: (changes: FileChange[]) => void) => {
          emitFileChanges = callback;
          return () => {};
        }),
      },
    } as never;
    useSettingsStore().config.workingDirectory = PROJECT;
    useConversationsStore().currentConversationId = 'conv-1';
    useChatStore().setCurrentConversation('conv-1');
  });

  it('lists project entries under their own heading, after the session grants', async () => {
    const wrapper = await mountOpen();

    expect(getProjectPermissions).toHaveBeenCalledWith(PROJECT);
    expect(wrapper.find('[data-testid="session-permissions-heading"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="project-permissions-heading"]').exists()).toBe(true);
    const rows = wrapper.findAll('[data-testid="project-permission"]');
    expect(rows.map(r => r.text())).toEqual([
      expect.stringContaining('Bash'),
      expect.stringContaining('Write'),
    ]);
    expect(rows[0].text()).toContain('npm test');
    expect(rows[1].text()).toContain('Any use of this tool');
    expect(rows[1].text()).toContain('shared, read-only');
  });

  it('counts session and project permissions in the badge', async () => {
    const wrapper = await mountOpen();

    expect(wrapper.find('button').attributes('title')).toBe('3 permissions active');
  });

  it('offers revoke only for entries in the local settings file', async () => {
    const wrapper = await mountOpen();

    const rows = wrapper.findAll('[data-testid="project-permission"]');
    expect(rows[0].find('[data-testid="revoke-project-permission"]').exists()).toBe(true);
    expect(rows[1].find('[data-testid="revoke-project-permission"]').exists()).toBe(false);
  });

  it('revokes through IPC and shows the list it returns', async () => {
    const wrapper = await mountOpen();

    await wrapper.find('[data-testid="revoke-project-permission"]').trigger('click');
    await flushPromises();

    expect(revokeProjectPermission).toHaveBeenCalledWith(PROJECT, 'rule', 'Bash(npm test)');
    expect(wrapper.findAll('[data-testid="project-permission"]')).toHaveLength(1);
  });

  it('re-reads when a project settings file changes, and only then', async () => {
    await mountOpen();
    getProjectPermissions.mockClear();

    emitFileChanges([{ type: 'change', path: `${PROJECT}/src/index.ts` }]);
    await flushPromises();
    expect(getProjectPermissions).not.toHaveBeenCalled();

    emitFileChanges([{ type: 'change', path: `${PROJECT}/.claude/settings.local.json` }]);
    await flushPromises();
    expect(getProjectPermissions).toHaveBeenCalledWith(PROJECT);
  });

  it('matches Windows paths from the watcher too', async () => {
    await mountOpen();
    getProjectPermissions.mockClear();

    emitFileChanges([{ type: 'add', path: 'C:\\work\\project\\.claude\\settings.json' }]);
    await flushPromises();

    expect(getProjectPermissions).toHaveBeenCalledTimes(1);
  });

  it('re-reads for the new project when the working directory changes', async () => {
    await mountOpen();
    getProjectPermissions.mockClear();

    useSettingsStore().config.workingDirectory = '/home/user/other';
    await flushPromises();

    expect(getProjectPermissions).toHaveBeenCalledWith('/home/user/other');
  });
});
