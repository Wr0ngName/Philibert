/**
 * Settings → Tools and Settings → Project, as the user meets them: the tools
 * every project has, each on or off everywhere; and one project's own — its
 * servers, the global tools it turns off for itself, and what it allows
 * without asking. Off everywhere wins: a project shows it, and cannot turn
 * it back on.
 *
 * The dialog is real; only the preload API is faked (support/settings-boundary),
 * its answers shaped as the main process gives them.
 */

import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { GlobalTools, GlobalToolStatus, McpServerEntry, ProjectPermissionEntry, ProjectTools } from '@shared/types';
import { DEFAULT_CONFIG } from '@shared/types';

import { useSettingsStore } from '../../../stores/settings';

import { fakeElectron, mountSettings } from './support/settings-boundary';

const HERE = '/home/user/here';
const THERE = '/home/user/there';

const connector = (name: string, status: GlobalToolStatus['status'], extra: Partial<GlobalToolStatus> = {}): GlobalToolStatus =>
  ({ name: `claude.ai ${name}`, kind: 'connector', status, ...extra });
const userStatus = (name: string, status: GlobalToolStatus['status']): GlobalToolStatus => ({ name, kind: 'user', status });
const userServer = (name: string, enabled = true): McpServerEntry => ({ name, transport: 'stdio', command: '/bin/notes', enabled });

let mcp: Record<string, ReturnType<typeof vi.fn>>;
let claude: Record<string, ReturnType<typeof vi.fn>>;
let wrapper: ReturnType<typeof mountSettings> | null = null;

function globalTools(over: Partial<GlobalTools> = {}): GlobalTools {
  return { statuses: [], userServers: [], offEverywhere: [], ...over };
}
function projectTools(over: Partial<ProjectTools> = {}): ProjectTools {
  return { statuses: [], userServers: [], offEverywhere: [], ...over };
}

async function open(tab: 'Tools' | 'Project') {
  wrapper = mountSettings();
  await flushPromises();
  await wrapper.findAll('[role="tab"]').find((t) => t.text() === tab)!.trigger('click');
  await flushPromises();
  return wrapper;
}

function page(name: 'tools' | 'project') {
  return wrapper!.find(`#settings-page-${name}`);
}

async function press(within: ReturnType<typeof page>, text: string) {
  const button = within.findAll('button').find((b) => b.text() === text);
  if (!button) throw new Error(`no "${text}" button in ${within.text()}`);
  await button.trigger('click');
  await flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mcp = {
    globalTools: vi.fn().mockResolvedValue(globalTools()),
    setOffEverywhere: vi.fn(),
    authorizeConnector: vi.fn().mockResolvedValue(undefined),
    projectTools: vi.fn().mockResolvedValue(projectTools()),
    setEnabledInProject: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
  };
  claude = {
    getProjectPermissions: vi.fn().mockResolvedValue([]),
    revokeProjectPermission: vi.fn(),
  };
  fakeElectron({ mcp, claude });
  useSettingsStore().config = { ...DEFAULT_CONFIG, workingDirectory: HERE, recentProjects: [THERE] };
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('Settings → Tools', () => {
  it('starts nothing until its tab is shown: checking starts Claude Code for seconds', async () => {
    wrapper = mountSettings();
    await flushPromises();
    expect(mcp.globalTools).not.toHaveBeenCalled();
    expect(mcp.projectTools).not.toHaveBeenCalled();

    await wrapper.findAll('[role="tab"]').find((t) => t.text() === 'Tools')!.trigger('click');
    await flushPromises();
    expect(mcp.globalTools).toHaveBeenCalledTimes(1);
    expect(mcp.projectTools).not.toHaveBeenCalled();
  });

  it('lists the connectors with how each stands, and your servers, with no project needed', async () => {
    useSettingsStore().config.workingDirectory = '';
    mcp.globalTools.mockResolvedValue(globalTools({
      statuses: [connector('Claude Docs', 'connected', { toolCount: 8 }), connector('Gmail', 'failed', { error: 'Server returned 500' }), userStatus('notes', 'connected')],
      userServers: [userServer('notes')],
    }));
    await open('Tools');

    const text = page('tools').text();
    expect(text).toContain('Claude Docs');
    expect(text).toContain('8 tools for Claude');
    expect(text).toContain('Server returned 500');
    expect(text).toContain('notes');
    expect(text).toContain('available in every project');
  });

  it('turns a connector off everywhere, and back on — still listed though Claude Code no longer reports it', async () => {
    mcp.globalTools.mockResolvedValue(globalTools({ statuses: [connector('Gmail', 'needs-auth')] }));
    mcp.setOffEverywhere.mockResolvedValueOnce(globalTools({ statuses: [], offEverywhere: ['claude.ai Gmail'] }));
    await open('Tools');

    await press(page('tools').find('[data-connector="claude.ai Gmail"]'), 'Turn off everywhere');
    expect(mcp.setOffEverywhere).toHaveBeenCalledWith('claude.ai Gmail', true);
    const row = page('tools').find('[data-connector="claude.ai Gmail"]');
    expect(row.text()).toContain('Off everywhere');
    expect(row.text()).toContain("Claude doesn't get it in any project");
    expect(row.text()).not.toContain('Authorise');

    mcp.setOffEverywhere.mockResolvedValueOnce(globalTools({ statuses: [connector('Gmail', 'needs-auth')] }));
    await press(row, 'Turn back on');
    expect(mcp.setOffEverywhere).toHaveBeenLastCalledWith('claude.ai Gmail', false);
    expect(page('tools').find('[data-connector="claude.ai Gmail"]').text()).toContain('Needs authorising');
  });

  it('authorises one on claude.ai, then says what is left to do', async () => {
    mcp.globalTools.mockResolvedValue(globalTools({ statuses: [connector('Gmail', 'needs-auth')] }));
    await open('Tools');

    await press(page('tools').find('[data-connector="claude.ai Gmail"]'), 'Authorise');

    expect(mcp.authorizeConnector).toHaveBeenCalledWith('claude.ai Gmail');
    expect(page('tools').text()).toContain('Finish on the claude.ai page that opened in your browser');
  });

  it('lists what else is off everywhere, so it can be turned back on', async () => {
    mcp.globalTools.mockResolvedValue(globalTools({ offEverywhere: ['gsc'] }));
    mcp.setOffEverywhere.mockResolvedValue(globalTools());
    await open('Tools');

    await press(page('tools').find('[data-off-everywhere="gsc"]'), 'Turn back on');

    expect(mcp.setOffEverywhere).toHaveBeenCalledWith('gsc', false);
    expect(page('tools').find('[data-off-everywhere="gsc"]').exists()).toBe(false);
  });

  it('asks to sign in when no session can start', async () => {
    mcp.globalTools.mockResolvedValue(globalTools({ statuses: null }));
    await open('Tools');

    expect(page('tools').text()).toContain('Sign in to Claude to see the connectors of your claude.ai account.');
  });

  it('shows why an action failed, as the main process words it, and changes nothing', async () => {
    mcp.globalTools.mockResolvedValue(globalTools({ statuses: [connector('Gmail', 'connected')] }));
    mcp.setOffEverywhere.mockRejectedValue(
      new Error("Error invoking remote method 'mcp:set-off-everywhere': Error: settings.json does not hold a JSON object"),
    );
    await open('Tools');

    await press(page('tools').find('[data-connector="claude.ai Gmail"]'), 'Turn off everywhere');

    expect(page('tools').text()).toContain('settings.json does not hold a JSON object');
    expect(page('tools').text()).not.toContain("Error invoking remote method");
    expect(page('tools').find('[data-connector="claude.ai Gmail"]').text()).toContain('Connected');
  });
});

describe('Settings → Project', () => {
  it("says which folder it is about — the open discussion's — and reads that project", async () => {
    await open('Project');

    expect((page('project').find('#project-settings-folder').element as HTMLSelectElement).value).toBe(HERE);
    expect(mcp.list).toHaveBeenCalledWith(HERE);
    expect(mcp.projectTools).toHaveBeenCalledWith(HERE);
    expect(claude.getProjectPermissions).toHaveBeenCalledWith(HERE);
  });

  it('shows each global tool as the project has it — and offers no switch for one off everywhere', async () => {
    mcp.projectTools.mockResolvedValue(projectTools({
      statuses: [connector('Calendar', 'connected'), userStatus('notes', 'disabled')],
      userServers: ['notes', 'jotter'],
      offEverywhere: ['jotter', 'claude.ai Gmail'],
    }));
    await open('Project');

    const row = (name: string) => page('project').find(`[data-tool="${name}"]`);
    expect(row('claude.ai Calendar').text()).toContain('On');
    expect(row('claude.ai Calendar').text()).toContain('Turn off here');
    expect(row('notes').text()).toContain('On globally · off in this project');
    expect(row('notes').text()).toContain('Turn on here');
    for (const name of ['jotter', 'claude.ai Gmail']) {
      expect(row(name).text()).toContain('Off in global settings');
      expect(row(name).find('.project-tool-switch').exists()).toBe(false);
    }
  });

  it('turns one off in the project, and back on', async () => {
    mcp.projectTools.mockResolvedValue(projectTools({ statuses: [userStatus('notes', 'connected')], userServers: ['notes'] }));
    mcp.setEnabledInProject.mockResolvedValueOnce(projectTools({ statuses: [userStatus('notes', 'disabled')], userServers: ['notes'] }));
    await open('Project');

    await press(page('project').find('[data-tool="notes"]'), 'Turn off here');
    expect(mcp.setEnabledInProject).toHaveBeenCalledWith(HERE, 'notes', false);
    expect(page('project').find('[data-tool="notes"]').text()).toContain('On globally · off in this project');

    mcp.setEnabledInProject.mockResolvedValueOnce(projectTools({ statuses: [userStatus('notes', 'connected')], userServers: ['notes'] }));
    await press(page('project').find('[data-tool="notes"]'), 'Turn on here');
    expect(mcp.setEnabledInProject).toHaveBeenLastCalledWith(HERE, 'notes', true);
  });

  it('sends the user to Tools to turn back on one off everywhere', async () => {
    mcp.projectTools.mockResolvedValue(projectTools({ offEverywhere: ['claude.ai Gmail'] }));
    await open('Project');

    await press(page('project').find('[data-tool="claude.ai Gmail"]'), 'Change it in Tools');

    expect(page('tools').isVisible()).toBe(true);
    expect(page('project').isVisible()).toBe(false);
  });

  it('reads another project when one is picked', async () => {
    await open('Project');
    vi.clearAllMocks();

    await page('project').find('#project-settings-folder').setValue(THERE);
    await flushPromises();

    expect(mcp.list).toHaveBeenCalledWith(THERE);
    expect(mcp.projectTools).toHaveBeenCalledWith(THERE);
    expect(claude.getProjectPermissions).toHaveBeenCalledWith(THERE);
  });

  it("lists what it allows without asking; the local ones can be removed, the shared ones not", async () => {
    const local: ProjectPermissionEntry = { kind: 'rule', value: 'Bash(npm test)', toolName: 'Bash', ruleContent: 'npm test', source: 'local' };
    const shared: ProjectPermissionEntry = { kind: 'directory', value: '/srv/data', source: 'shared' };
    claude.getProjectPermissions.mockResolvedValue([local, shared]);
    claude.revokeProjectPermission.mockResolvedValue([shared]);
    await open('Project');

    const entries = page('project').findAll('.project-permission');
    expect(entries.map((e) => e.text())).toEqual([
      expect.stringContaining('npm test'),
      expect.stringContaining('/srv/data'),
    ]);
    expect(entries[1]!.text()).toContain('shared, read-only');
    expect(entries[1]!.findAll('button')).toHaveLength(0);

    await press(entries[0]!, 'Remove');
    expect(claude.revokeProjectPermission).toHaveBeenCalledWith(HERE, 'rule', 'Bash(npm test)');
    expect(page('project').findAll('.project-permission')).toHaveLength(1);
  });

  it('asks for a project folder when there is none', async () => {
    useSettingsStore().config = { ...DEFAULT_CONFIG, workingDirectory: '', recentProjects: [] };
    await open('Project');

    expect(page('project').text()).toContain('Choose a project folder first');
    expect(mcp.projectTools).not.toHaveBeenCalled();
  });
});
