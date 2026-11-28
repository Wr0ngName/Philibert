/**
 * A shell command's card says how the command will run — in the
 * discussion's sandbox, or as the user anywhere on the computer — and a
 * grant that lets every command of the shell through beyond the sandbox
 * takes a second, deliberate click.
 */

import { mount } from '@vue/test-utils';
import { describe, it, expect, afterEach } from 'vitest';

import { SANDBOXED_SHELL_SUMMARY, UNSANDBOXED_SHELL_SUMMARY } from '@shared/sandbox';
import type { PendingAction, PermissionScopeOption, ShellRunContext } from '@shared/types';

import ActionApproval from '../ActionApproval.vue';

const OPTIONS: PermissionScopeOption[] = [
  { scope: 'session', label: 'Allow Bash this session', description: 'Allow all Bash for this session' },
  { scope: 'session', variant: 'narrow', label: 'Allow this exact command this session', description: 'Allow only this exact command for this session' },
  { scope: 'project', label: 'Allow Bash in project', description: 'Allow all Bash in this project' },
];

function bashAction(shell: ShellRunContext | undefined, overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    id: 'act-1',
    type: 'bash-command',
    toolName: 'Bash',
    description: 'Run command: make',
    input: { command: 'make' },
    status: 'pending',
    timestamp: 0,
    details: { command: 'make', workingDirectory: '' },
    permissionInfo: { alwaysAllowLabel: 'Allow Bash in project', description: '', scope: 'project', scopeOptions: OPTIONS },
    ...(shell ? { shell } : {}),
    ...overrides,
  } as PendingAction;
}

let wrapper: ReturnType<typeof mount> | null = null;

function mountCard(pending: PendingAction) {
  wrapper = mount(ActionApproval, { props: { action: pending }, attachTo: document.body, global: { stubs: { Icon: true } } });
  return wrapper;
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

function button(card: ReturnType<typeof mount>, label: string) {
  const found = card.findAll('button').find((b) => b.text().trim() === label);
  if (!found) throw new Error(`No button "${label}" in: ${card.findAll('button').map((b) => b.text().trim()).join(' | ')}`);
  return found;
}

describe('a shell command card', () => {
  it('says a sandboxed command can change only the discussion\'s folder', () => {
    const card = mountCard(bashAction({ sandboxed: true }));

    expect(card.get('[data-testid="shell-sandbox-banner"]').text()).toBe(SANDBOXED_SHELL_SUMMARY);
  });

  it('says an unsandboxed command can change anything, anywhere', () => {
    const card = mountCard(bashAction({ sandboxed: false }));

    expect(card.get('[data-testid="shell-sandbox-banner"]').text()).toBe(UNSANDBOXED_SHELL_SUMMARY);
  });

  it('says a request to leave the sandbox is not granted', () => {
    const card = mountCard(bashAction({ sandboxed: true, escapeRefused: true }));

    expect(card.get('[data-testid="shell-escape-refused"]').text()).toContain('so it runs inside');
  });

  it('says nothing of a sandbox for a tool that is not a shell', () => {
    const card = mountCard(bashAction(undefined, { toolName: 'WebFetch' }));

    expect(card.find('[data-testid="shell-sandbox-banner"]').exists()).toBe(false);
  });

  it('grants the whole shell for a sandboxed session at one click: the sandbox still holds it', async () => {
    const card = mountCard(bashAction({ sandboxed: true }));

    await button(card, 'Allow Bash this session').trigger('click');

    expect(card.emitted('approve')).toEqual([['act-1', true, 'session', undefined]]);
  });

  it('asks again before granting the whole shell to an unsandboxed session, and grants it on the second click', async () => {
    const card = mountCard(bashAction({ sandboxed: false }));

    await button(card, 'Allow Bash this session').trigger('click');
    expect(card.emitted('approve')).toBeUndefined();
    expect(card.get('[data-testid="broad-shell-confirm"]').text()).toContain('anywhere on this computer');

    await card.get('[data-testid="broad-shell-confirm-yes"]').trigger('click');
    expect(card.emitted('approve')).toEqual([['act-1', true, 'session', undefined]]);
  });

  it('asks again before saving the whole shell for the project, even in the sandbox', async () => {
    const card = mountCard(bashAction({ sandboxed: true }));

    await button(card, 'Allow Bash in project').trigger('click');
    expect(card.emitted('approve')).toBeUndefined();
    expect(card.get('[data-testid="broad-shell-confirm"]').text()).toContain('every discussion of this project');

    await button(card, 'Cancel').trigger('click');
    expect(card.find('[data-testid="broad-shell-confirm"]').exists()).toBe(false);
    expect(card.emitted('approve')).toBeUndefined();
  });

  it('grants one command at one click, sandboxed or not', async () => {
    const card = mountCard(bashAction({ sandboxed: false }));

    await button(card, 'Allow this exact command this session').trigger('click');

    expect(card.emitted('approve')).toEqual([['act-1', true, 'session', 'narrow']]);
  });

  it('asks again from the keyboard too', async () => {
    const card = mountCard(bashAction({ sandboxed: false }));
    (card.element as HTMLElement).focus();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));
    await card.vm.$nextTick();
    expect(card.emitted('approve')).toBeUndefined();
    expect(card.find('[data-testid="broad-shell-confirm"]').exists()).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));
    expect(card.emitted('approve')).toEqual([['act-1', true, 'session', undefined]]);
  });
});

describe('a network ask from a sandboxed command', () => {
  it('names the host', () => {
    const card = mountCard(bashAction(undefined, {
      toolName: 'SandboxNetworkAccess',
      description: 'Network access: example.com',
      networkHost: 'example.com',
      type: 'generic-tool',
      input: { host: 'example.com' },
      details: { rawInput: { host: 'example.com' }, secondaryFields: [{ label: 'host', value: 'example.com' }], jsonFields: [] },
    } as unknown as Partial<PendingAction>));

    expect(card.get('[data-testid="network-host-banner"]').text()).toContain('example.com');
  });
});
