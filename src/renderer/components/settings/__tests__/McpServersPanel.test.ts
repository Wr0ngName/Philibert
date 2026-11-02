/**
 * Tests for McpServersPanel.
 *
 * The panel is the only place a non-technical user meets MCP, so these cover
 * the behaviours that decide whether they end up with a working server:
 * the empty and no-project states, that saving sends exactly what the user
 * typed, that a bad program path is called out before saving, and that a
 * failed save keeps the form open with its contents intact.
 *
 * `window.electron.mcp` is the process boundary, so it is the only thing
 * mocked; the store runs for real.
 */

import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { McpServerEntry } from '@shared/types';

import { useSettingsStore } from '../../../stores/settings';
import McpServersPanel from '../McpServersPanel.vue';

const PROJECT = '/home/user/project';

const mcpApi = {
  list: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  setEnabled: vi.fn(),
  checkCommand: vi.fn(),
  getRuntimeInfo: vi.fn(),
  pickExecutable: vi.fn(),
  pickFile: vi.fn(),
  connectors: vi.fn(),
  authorizeConnector: vi.fn(),
  setConnectorEnabled: vi.fn(),
};

function stdioServer(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    name: 'gsc',
    transport: 'stdio',
    command: '/opt/gsc-mcp',
    enabled: true,
    check: { ok: true },
    ...overrides,
  };
}

function mountPanel() {
  return mount(McpServersPanel, {
    global: {
      stubs: { Icon: true },
    },
  });
}

/** Point the settings store at a project, or at none when null. */
function setProject(dir: string | null): void {
  const settings = useSettingsStore();
  settings.config.workingDirectory = dir ?? '';
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();

  mcpApi.list.mockResolvedValue([]);
  mcpApi.getRuntimeInfo.mockResolvedValue({
    platform: 'linux',
    bundledNodePath: null,
    configPath: `${PROJECT}/.mcp.json`,
    approvalsPath: `${PROJECT}/.claude/settings.local.json`,
  });
  mcpApi.checkCommand.mockResolvedValue({ ok: true });
  mcpApi.connectors.mockResolvedValue([]);
  mcpApi.authorizeConnector.mockResolvedValue(undefined);

  (window as unknown as { electron: unknown }).electron = { mcp: mcpApi };
  setProject(PROJECT);
});

describe('project gating', () => {
  it('asks for a project folder before showing any controls', async () => {
    setProject(null);
    const wrapper = mountPanel();
    await flushPromises();

    expect(wrapper.text()).toContain('Choose a project folder first');
    expect(wrapper.text()).not.toContain('Add server');
    expect(mcpApi.list).not.toHaveBeenCalled();
  });

  it('loads the project servers on mount', async () => {
    mountPanel();
    await flushPromises();

    expect(mcpApi.list).toHaveBeenCalledWith(PROJECT);
    expect(mcpApi.getRuntimeInfo).toHaveBeenCalledWith(PROJECT);
  });
});

describe('server list', () => {
  it('shows an empty state when the project declares none', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    expect(wrapper.text()).toContain('No tool servers yet');
  });

  it('lists a server with its command and on/off state', async () => {
    mcpApi.list.mockResolvedValue([stdioServer({ args: ['--verbose'] })]);
    const wrapper = mountPanel();
    await flushPromises();

    expect(wrapper.text()).toContain('gsc');
    expect(wrapper.text()).toContain('/opt/gsc-mcp --verbose');
    expect(wrapper.text()).toContain('On');
  });

  it('shows a remote server by its url', async () => {
    mcpApi.list.mockResolvedValue([
      { name: 'remote', transport: 'http', url: 'https://example.com/mcp', enabled: true },
    ]);
    const wrapper = mountPanel();
    await flushPromises();

    expect(wrapper.text()).toContain('https://example.com/mcp');
  });

  it('surfaces a broken command so the user sees why it will not work', async () => {
    mcpApi.list.mockResolvedValue([
      stdioServer({
        command: 'npx',
        check: { ok: false, problem: 'no-package-runner', message: 'Philibert does not include npx.' },
      }),
    ]);
    const wrapper = mountPanel();
    await flushPromises();

    expect(wrapper.text()).toContain('Philibert does not include npx.');
  });

  it('turns a server off through the store', async () => {
    mcpApi.list.mockResolvedValue([stdioServer()]);
    mcpApi.setEnabled.mockResolvedValue([stdioServer({ enabled: false })]);
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.findAll('button').find((b) => b.text() === 'Turn off')!.trigger('click');
    await flushPromises();

    expect(mcpApi.setEnabled).toHaveBeenCalledWith(PROJECT, 'gsc', false);
    expect(wrapper.text()).toContain('Off');
  });

  it('requires confirmation before removing', async () => {
    mcpApi.list.mockResolvedValue([stdioServer()]);
    mcpApi.remove.mockResolvedValue([]);
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.find('button[title="Remove"]').trigger('click');
    await flushPromises();
    expect(mcpApi.remove).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Remove “gsc” from this project?');

    await wrapper.findAll('button').find((b) => b.text() === 'Remove' && !b.attributes('title'))!
      .trigger('click');
    await flushPromises();

    expect(mcpApi.remove).toHaveBeenCalledWith(PROJECT, 'gsc');
  });
});

describe('adding a server', () => {
  async function openForm() {
    const wrapper = mountPanel();
    await flushPromises();
    await wrapper.findAll('button').find((b) => b.text().includes('Add server'))!.trigger('click');
    await flushPromises();
    return wrapper;
  }

  it('sends the typed program and arguments', async () => {
    mcpApi.save.mockResolvedValue([stdioServer()]);
    const wrapper = await openForm();

    await wrapper.find('#mcp-name').setValue('gsc');
    await wrapper.find('#mcp-command').setValue('/opt/gsc-mcp');
    await wrapper.find('#mcp-args').setValue('--verbose\n\n--port 80');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(mcpApi.save).toHaveBeenCalledWith(PROJECT, null, {
      name: 'gsc',
      transport: 'stdio',
      command: '/opt/gsc-mcp',
      args: ['--verbose', '--port 80'],
      env: undefined,
    });
  });

  it('sends variables the user added', async () => {
    mcpApi.save.mockResolvedValue([stdioServer()]);
    const wrapper = await openForm();

    await wrapper.find('#mcp-name').setValue('gsc');
    await wrapper.find('#mcp-command').setValue('/opt/gsc-mcp');
    await wrapper.findAll('button').find((b) => b.text().includes('Add a variable'))!
      .trigger('click');
    await flushPromises();

    const pairInputs = wrapper.findAll('input[type="text"]');
    await pairInputs[pairInputs.length - 2].setValue('GOOGLE_SERVICE_ACCOUNT_FILE');
    await pairInputs[pairInputs.length - 1].setValue('/home/user/key.json');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(mcpApi.save).toHaveBeenCalledWith(
      PROJECT,
      null,
      expect.objectContaining({
        env: { GOOGLE_SERVICE_ACCOUNT_FILE: '/home/user/key.json' },
      })
    );
  });

  it('switches to url fields for a remote server', async () => {
    mcpApi.save.mockResolvedValue([]);
    const wrapper = await openForm();

    await wrapper.findAll('button').find((b) => b.text().includes('A web address'))!
      .trigger('click');
    await flushPromises();

    expect(wrapper.find('#mcp-command').exists()).toBe(false);
    await wrapper.find('#mcp-name').setValue('remote');
    await wrapper.find('#mcp-url').setValue('https://example.com/mcp');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(mcpApi.save).toHaveBeenCalledWith(PROJECT, null, {
      name: 'remote',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: undefined,
    });
  });

  it('warns about a bad program path while typing, before any save', async () => {
    mcpApi.checkCommand.mockResolvedValue({
      ok: false,
      problem: 'no-package-runner',
      message: 'Philibert does not include npx.',
    });
    const wrapper = await openForm();

    await wrapper.find('#mcp-command').setValue('npx');
    await flushPromises();

    expect(mcpApi.checkCommand).toHaveBeenCalledWith('npx');
    expect(wrapper.text()).toContain('Philibert does not include npx.');
    expect(mcpApi.save).not.toHaveBeenCalled();
  });

  it('will not let a server be added with a program that cannot run', async () => {
    mcpApi.checkCommand.mockResolvedValue({
      ok: false,
      problem: 'not-found',
      message: 'No file at that path.',
    });
    const wrapper = await openForm();

    await wrapper.find('#mcp-name').setValue('gsc');
    await wrapper.find('#mcp-command').setValue('/gone/missing');
    await flushPromises();

    const add = wrapper.findAll('button').find((b) => b.text() === 'Add')!;
    expect(add.attributes('disabled')).toBeDefined();

    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(mcpApi.save).not.toHaveBeenCalled();
  });

  it('re-enables Add once the program path is corrected', async () => {
    mcpApi.checkCommand.mockResolvedValueOnce({
      ok: false,
      problem: 'not-found',
      message: 'No file at that path.',
    });
    const wrapper = await openForm();

    await wrapper.find('#mcp-name').setValue('gsc');
    await wrapper.find('#mcp-command').setValue('/gone/missing');
    await flushPromises();
    expect(wrapper.findAll('button').find((b) => b.text() === 'Add')!.attributes('disabled'))
      .toBeDefined();

    mcpApi.checkCommand.mockResolvedValue({ ok: true });
    await wrapper.find('#mcp-command').setValue('/opt/gsc-mcp');
    await flushPromises();

    expect(wrapper.findAll('button').find((b) => b.text() === 'Add')!.attributes('disabled'))
      .toBeUndefined();
    expect(wrapper.text()).toContain('Found — this program can be started.');
  });

  it('does not block a remote server on a stale program check', async () => {
    mcpApi.checkCommand.mockResolvedValue({
      ok: false,
      problem: 'not-found',
      message: 'No file at that path.',
    });
    mcpApi.save.mockResolvedValue([]);
    const wrapper = await openForm();

    await wrapper.find('#mcp-command').setValue('/gone/missing');
    await flushPromises();

    await wrapper.findAll('button').find((b) => b.text().includes('A web address'))!
      .trigger('click');
    await wrapper.find('#mcp-name').setValue('remote');
    await wrapper.find('#mcp-url').setValue('https://example.com/mcp');
    await flushPromises();

    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(mcpApi.save).toHaveBeenCalled();
  });

  it('fills the program field from the file picker', async () => {
    mcpApi.pickExecutable.mockResolvedValue('/picked/server');
    const wrapper = await openForm();

    await wrapper.findAll('button').find((b) => b.text() === 'Browse…')!.trigger('click');
    await flushPromises();

    expect((wrapper.find('#mcp-command').element as HTMLInputElement).value)
      .toBe('/picked/server');
  });

  it('keeps the form open with its values when saving fails', async () => {
    mcpApi.save.mockRejectedValue(
      new Error("Error invoking remote method 'mcp:save': A server named \"gsc\" already exists in this project.")
    );
    const wrapper = await openForm();

    await wrapper.find('#mcp-name').setValue('gsc');
    await wrapper.find('#mcp-command').setValue('/opt/gsc-mcp');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(wrapper.find('form').exists()).toBe(true);
    expect((wrapper.find('#mcp-name').element as HTMLInputElement).value).toBe('gsc');
    // The main process message is shown without Electron's IPC wrapper text.
    expect(wrapper.text()).toContain('A server named "gsc" already exists in this project.');
    expect(wrapper.text()).not.toContain('Error invoking remote method');
  });

  it('closes the form after a successful save', async () => {
    mcpApi.save.mockResolvedValue([stdioServer()]);
    const wrapper = await openForm();

    await wrapper.find('#mcp-name').setValue('gsc');
    await wrapper.find('#mcp-command').setValue('/opt/gsc-mcp');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(wrapper.find('form').exists()).toBe(false);
    expect(wrapper.text()).toContain('gsc');
  });
});

describe('editing a server', () => {
  it('loads the existing values and saves under the previous name', async () => {
    mcpApi.list.mockResolvedValue([stdioServer({ env: { KEY: 'value' } })]);
    mcpApi.save.mockResolvedValue([stdioServer({ name: 'renamed' })]);
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.find('button[title="Edit"]').trigger('click');
    await flushPromises();

    expect((wrapper.find('#mcp-name').element as HTMLInputElement).value).toBe('gsc');
    expect((wrapper.find('#mcp-command').element as HTMLInputElement).value)
      .toBe('/opt/gsc-mcp');

    await wrapper.find('#mcp-name').setValue('renamed');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(mcpApi.save).toHaveBeenCalledWith(
      PROJECT,
      'gsc',
      expect.objectContaining({ name: 'renamed', env: { KEY: 'value' } })
    );
  });
});

describe('bundled Node helper', () => {
  it('is offered only when Philibert ships a Node binary', async () => {
    mcpApi.getRuntimeInfo.mockResolvedValue({
      platform: 'win32',
      bundledNodePath: 'C:\\Philibert\\resources\\node.exe',
      configPath: `${PROJECT}/.mcp.json`,
      approvalsPath: `${PROJECT}/.claude/settings.local.json`,
    });
    const wrapper = mountPanel();
    await flushPromises();
    await wrapper.findAll('button').find((b) => b.text().includes('Add server'))!.trigger('click');
    await flushPromises();

    const helper = wrapper.findAll('button')
      .find((b) => b.text().includes('Use the Node included with Philibert'));
    expect(helper).toBeDefined();

    await helper!.trigger('click');
    await flushPromises();

    expect((wrapper.find('#mcp-command').element as HTMLInputElement).value)
      .toBe('C:\\Philibert\\resources\\node.exe');
  });

  it('is hidden when no Node is bundled', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    await wrapper.findAll('button').find((b) => b.text().includes('Add server'))!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).not.toContain('Use the Node included with Philibert');
  });
});

describe('claude.ai connectors', () => {
  const GMAIL = 'claude.ai Gmail';

  /** The connector rows, as name and status. */
  function connectorRows(wrapper: ReturnType<typeof mountPanel>): string[] {
    return wrapper.findAll('.connector').map((row) =>
      `${row.find('.text-sm').text()}: ${row.find('.connector-status').text()}`);
  }

  function connectorButton(wrapper: ReturnType<typeof mountPanel>, name: string, label: string) {
    const button = wrapper.find(`[data-connector="${name}"]`).findAll('button').find((b) => b.text() === label);
    expect(button, `expected a ${label} button for ${name}`).toBeDefined();
    return button!;
  }

  it('lists each with how it stands, checked in the project', async () => {
    mcpApi.connectors.mockResolvedValue([
      { name: 'claude.ai Claude Docs', status: 'connected', toolCount: 8 },
      { name: GMAIL, status: 'needs-auth' },
      { name: 'claude.ai Asana', status: 'failed', error: 'Server returned 500' },
      { name: 'claude.ai Drive', status: 'disabled' },
    ]);
    const wrapper = mountPanel();
    await flushPromises();

    expect(mcpApi.connectors).toHaveBeenCalledWith(PROJECT);
    expect(connectorRows(wrapper)).toEqual([
      'Claude Docs: Connected',
      'Gmail: Needs authorising',
      'Asana: Failed',
      'Drive: Off in this project',
    ]);
    expect(wrapper.text()).toContain('8 tools for Claude');
    expect(wrapper.text()).toContain('Server returned 500');
  });

  it('authorises one on claude.ai, then says what is left to do until checked again', async () => {
    mcpApi.connectors.mockResolvedValue([{ name: GMAIL, status: 'needs-auth' }]);
    const wrapper = mountPanel();
    await flushPromises();

    await connectorButton(wrapper, GMAIL, 'Authorise').trigger('click');
    await flushPromises();

    expect(mcpApi.authorizeConnector).toHaveBeenCalledWith(PROJECT, GMAIL);
    expect(wrapper.text()).toContain('Finish on the claude.ai page that opened in your browser');

    mcpApi.connectors.mockResolvedValue([{ name: GMAIL, status: 'connected', toolCount: 3 }]);
    await wrapper.findAll('button').find((b) => b.text() === 'Check again')!.trigger('click');
    await flushPromises();

    expect(connectorRows(wrapper)).toEqual(['Gmail: Connected']);
    expect(wrapper.text()).not.toContain('Finish on the claude.ai page');
  });

  it('turns one off for the project, and back on', async () => {
    mcpApi.connectors.mockResolvedValue([{ name: GMAIL, status: 'needs-auth' }]);
    mcpApi.setConnectorEnabled.mockResolvedValue([{ name: GMAIL, status: 'disabled' }]);
    const wrapper = mountPanel();
    await flushPromises();

    await connectorButton(wrapper, GMAIL, 'Turn off').trigger('click');
    await flushPromises();
    expect(mcpApi.setConnectorEnabled).toHaveBeenCalledWith(PROJECT, GMAIL, false);
    expect(connectorRows(wrapper)).toEqual(['Gmail: Off in this project']);

    mcpApi.setConnectorEnabled.mockResolvedValue([{ name: GMAIL, status: 'needs-auth' }]);
    await connectorButton(wrapper, GMAIL, 'Turn on').trigger('click');
    await flushPromises();
    expect(mcpApi.setConnectorEnabled).toHaveBeenLastCalledWith(PROJECT, GMAIL, true);
  });

  it('asks to sign in when no session can start, and says when there are none', async () => {
    mcpApi.connectors.mockResolvedValue(null);
    let wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.text()).toContain('Sign in to Claude to see the connectors of your claude.ai account.');
    wrapper.unmount();

    mcpApi.connectors.mockResolvedValue([]);
    wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.text()).toContain('No claude.ai connectors.');
  });

  it('shows why an action failed', async () => {
    mcpApi.connectors.mockResolvedValue([{ name: GMAIL, status: 'needs-auth' }]);
    mcpApi.authorizeConnector.mockRejectedValue(
      new Error("Error invoking remote method 'mcp:connector-authorize': Error: Claude Code gave no claude.ai page to authorise claude.ai Gmail."),
    );
    const wrapper = mountPanel();
    await flushPromises();

    await connectorButton(wrapper, GMAIL, 'Authorise').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Claude Code gave no claude.ai page to authorise claude.ai Gmail.');
    expect(wrapper.text()).not.toContain('Error invoking remote method');
  });
});
