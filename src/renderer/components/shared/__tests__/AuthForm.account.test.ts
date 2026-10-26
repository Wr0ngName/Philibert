/**
 * The logged-in account, shown in the Authentication section.
 *
 * So the user can check WHICH account the app is using, which is only worth
 * anything if it is right: the account of the current login, said plainly
 * when it cannot be read, and never left over from a previous login.
 */

import { flushPromises, mount } from '@vue/test-utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { AuthStatus, ClaudeAccount } from '@shared/types';

import AuthForm from '../AuthForm.vue';

const OAUTH: AuthStatus = { isAuthenticated: true, method: 'oauth', displayName: 'Claude Pro/Max Account' };
const API_KEY: AuthStatus = { isAuthenticated: true, method: 'api-key', displayName: 'API Key' };
const NONE: AuthStatus = { isAuthenticated: false, method: 'none' };

const auth = {
  getStatus: vi.fn<() => Promise<AuthStatus>>(),
  getAccount: vi.fn<() => Promise<ClaudeAccount | null>>(),
  startOAuth: vi.fn(),
  completeOAuth: vi.fn(),
  cancelOAuth: vi.fn(),
  logout: vi.fn(),
};

function accountLine(wrapper: ReturnType<typeof mount>): string | null {
  const line = wrapper.find('[data-testid="auth-account"]');
  return line.exists() ? line.text() : null;
}

describe('the account shown under Authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { electron: unknown }).electron = { auth, config: { set: vi.fn() } };
  });

  it('shows the email and plan of an OAuth login', async () => {
    auth.getStatus.mockResolvedValue(OAUTH);
    auth.getAccount.mockResolvedValue({ email: 'someone@example.com', subscriptionType: 'Claude Max' });

    const wrapper = mount(AuthForm);
    await flushPromises();

    expect(accountLine(wrapper)).toBe('someone@example.com · Claude Max');
  });

  it('says it is checking while the account is being read', async () => {
    auth.getStatus.mockResolvedValue(OAUTH);
    let answer!: (account: ClaudeAccount | null) => void;
    auth.getAccount.mockReturnValue(new Promise((resolve) => { answer = resolve; }));

    const wrapper = mount(AuthForm);
    await flushPromises();
    expect(accountLine(wrapper)).toBe('Checking account…');

    answer({ email: 'someone@example.com' });
    await flushPromises();
    expect(accountLine(wrapper)).toBe('someone@example.com');
  });

  it('explains an older token login instead of reporting a failure, and how to see the account', async () => {
    auth.getStatus.mockResolvedValue(OAUTH);
    auth.getAccount.mockResolvedValue({ tokenOnly: true });

    const wrapper = mount(AuthForm);
    await flushPromises();

    expect(accountLine(wrapper)).toContain('does not say which account it is');
    expect(accountLine(wrapper)).toContain('log in');
    expect(accountLine(wrapper)).not.toContain('Could not read');
  });

  it('says so when the account cannot be read, rather than showing nothing', async () => {
    auth.getStatus.mockResolvedValue(OAUTH);
    auth.getAccount.mockResolvedValue(null);

    const wrapper = mount(AuthForm);
    await flushPromises();

    expect(accountLine(wrapper)).toBe('Could not read which account this is.');
  });

  it('says so when the bridge call itself fails', async () => {
    auth.getStatus.mockResolvedValue(OAUTH);
    auth.getAccount.mockRejectedValue(new Error('channel closed'));

    const wrapper = mount(AuthForm);
    await flushPromises();

    expect(accountLine(wrapper)).toBe('Could not read which account this is.');
  });

  it('shows no account line for an API key, and does not ask', async () => {
    // An API key has no email behind it to show.
    auth.getStatus.mockResolvedValue(API_KEY);

    const wrapper = mount(AuthForm);
    await flushPromises();

    expect(accountLine(wrapper)).toBeNull();
    expect(auth.getAccount).not.toHaveBeenCalled();
  });

  it('drops the account on logout', async () => {
    auth.getStatus.mockResolvedValue(OAUTH);
    auth.getAccount.mockResolvedValue({ email: 'someone@example.com' });
    const wrapper = mount(AuthForm);
    await flushPromises();
    expect(accountLine(wrapper)).toBe('someone@example.com');

    auth.logout.mockResolvedValue(undefined);
    auth.getStatus.mockResolvedValue(NONE);
    await wrapper.findAll('button').find((b) => b.text() === 'Logout')!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).not.toContain('someone@example.com');
  });

  it('never shows an earlier read that answers after a newer one', async () => {
    // Logged in, logged out and in again as someone else while the first
    // read was still out: the first answer arriving last must not win.
    auth.getStatus.mockResolvedValue(OAUTH);
    let answerOld!: (account: ClaudeAccount | null) => void;
    auth.getAccount.mockReturnValueOnce(new Promise((resolve) => { answerOld = resolve; }));
    const wrapper = mount(AuthForm);
    await flushPromises();

    auth.getAccount.mockResolvedValueOnce({ email: 'new@example.com' });
    await (wrapper.vm as unknown as { refreshAuthStatus: () => Promise<void> }).refreshAuthStatus();
    await flushPromises();
    expect(accountLine(wrapper)).toBe('new@example.com');

    answerOld({ email: 'old@example.com' });
    await flushPromises();
    expect(accountLine(wrapper)).toBe('new@example.com');
  });
});
