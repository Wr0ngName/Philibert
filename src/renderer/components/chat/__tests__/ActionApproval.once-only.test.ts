/**
 * An ask the CLI says must be allowed once at most (the SDK's
 * `suppressAlwaysAllowRule`): the card offers Allow Once and Deny, and no
 * "always" — neither a button nor a shortcut.
 */

import { mount } from '@vue/test-utils';
import { describe, it, expect, afterEach } from 'vitest';

import type { PendingAction } from '@shared/types';

import ActionApproval from '../ActionApproval.vue';

function action(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    id: 'act-1',
    type: 'execute_command',
    toolName: 'Monitor',
    description: 'count ticks',
    input: { command: 'node -e "1"', description: 'count ticks' },
    status: 'pending',
    timestamp: 0,
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

function buttons(card: ReturnType<typeof mount>): string[] {
  return card.findAll('button').map((b) => b.text().trim()).filter(Boolean);
}

describe('a once-only ask', () => {
  it('offers Allow Once and Deny, and no "always"', () => {
    const card = mountCard(action({ onceOnly: true }));

    expect(buttons(card)).toEqual(['Deny', 'Allow Once']);
    expect(card.text()).not.toContain('always allow');
  });

  it('ignores the "always" shortcuts', async () => {
    const card = mountCard(action({ onceOnly: true }));
    (card.element as HTMLElement).focus();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'A' }));

    expect(card.emitted('approve')).toBeUndefined();
  });

  it('still offers "always" on an ordinary ask', () => {
    const card = mountCard(action());

    expect(buttons(card)).toContain('Always Allow');
  });
});
