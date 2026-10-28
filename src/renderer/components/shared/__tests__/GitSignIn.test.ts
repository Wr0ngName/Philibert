/**
 * Signing in during a push, as the window sees it: the push raises a login
 * request, the dialog asks the user, and their answer decides what the
 * push comes to.
 *
 * The real Git controls and sign-in dialog; the main process is stood in for
 * the way the real one behaves (GitService.credentials.test.ts tests that
 * end to end with git): a push needing a login asks, waits for the answer,
 * and returns a result saying whether the login was given, cancelled or
 * refused.
 */

import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, h } from 'vue';

import type { GitCredentialAnswer, GitCredentialRequest, GitRemoteResult } from '@shared/types';

import { useSettingsStore } from '../../../stores/settings';
import GitControls from '../GitControls.vue';
import GitCredentialDialog from '../GitCredentialDialog.vue';

const HOST = 'gitlab.example.com';
const RIGHT = { username: 'alice', password: 'glpat-right' };

describe('signing in during a push', () => {
  let requestListener: ((request: GitCredentialRequest) => void) | null;
  let pendingAnswer: ((answer: GitCredentialAnswer | null) => void) | null;
  let pushes: number;
  let app: ReturnType<typeof mount>;

  /** The main process: a push without a saved login asks for one. */
  function push(): Promise<GitRemoteResult> {
    pushes += 1;
    return new Promise((resolve) => {
      pendingAnswer = (answer) => {
        pendingAnswer = null;
        if (!answer) resolve({ ok: false, error: 'credential helper told us to quit', auth: { host: HOST, reason: 'cancelled' } });
        else if (answer.password !== RIGHT.password) resolve({ ok: false, error: 'Authentication failed', auth: { host: HOST, reason: 'rejected' } });
        else resolve({ ok: true, output: '' });
      };
      requestListener?.({ requestId: `r${pushes}`, protocol: 'https', host: HOST });
    });
  }

  beforeEach(async () => {
    setActivePinia(createPinia());
    requestListener = null;
    pendingAnswer = null;
    pushes = 0;
    (globalThis as unknown as { window: Record<string, unknown> }).window.electron = {
      git: {
        status: vi.fn().mockResolvedValue({ isGitRepo: true, branch: 'main', dirty: 0, ahead: 1, behind: 0 }),
        fetch: vi.fn().mockResolvedValue(undefined),
        listBranches: vi.fn().mockResolvedValue([]),
        getIdentity: vi.fn().mockResolvedValue({ name: 'A', email: 'a@example.com' }),
        onStatusChanged: () => () => {},
        push: vi.fn(() => push()),
        pull: vi.fn(),
        onCredentialRequest: (callback: (request: GitCredentialRequest) => void) => {
          requestListener = callback;
          return () => { requestListener = null; };
        },
        respondToCredentialRequest: vi.fn(async (_id: string, answer: GitCredentialAnswer | null) => {
          pendingAnswer?.(answer);
        }),
      },
    } as never;
    useSettingsStore().config.workingDirectory = '/home/user/project';

    app = mount(defineComponent({ render: () => [h(GitControls), h(GitCredentialDialog)] }), {
      attachTo: document.body,
      global: { stubs: { Icon: true } },
    });
    await flushPromises();
  });

  afterEach(() => {
    app.unmount();
    document.body.innerHTML = '';
  });

  async function clickPush(): Promise<void> {
    const button = app.find('button[title="Push main to remote"]');
    expect(button.exists(), 'expected the push button').toBe(true);
    await button.trigger('click');
    await flushPromises();
  }

  function form(): HTMLFormElement | null {
    return document.body.querySelector('[data-testid="git-credential-form"]');
  }

  async function signIn(login: { username: string; password: string }): Promise<void> {
    const [user, pass] = form()!.querySelectorAll('input');
    user.value = login.username;
    user.dispatchEvent(new Event('input'));
    pass.value = login.password;
    pass.dispatchEvent(new Event('input'));
    await flushPromises();
    form()!.dispatchEvent(new Event('submit'));
    await flushPromises();
  }

  function problem(): string | null {
    return document.body.querySelector('[data-testid="git-sign-in-problem"]')?.textContent ?? null;
  }

  it('asks for the login, naming the server, and pushes with it', async () => {
    await clickPush();

    expect(document.body.textContent).toContain(`Sign in to ${HOST}`);
    await signIn(RIGHT);

    expect(window.electron.git.respondToCredentialRequest).toHaveBeenCalledWith('r1', RIGHT);
    expect(form()).toBeNull();
    expect(problem()).toBeNull();
  });

  it('says the push needs a sign-in when it is cancelled, until the user acts', async () => {
    await clickPush();
    (document.body.querySelector('[data-testid="git-credential-form"] button[type="button"]') as HTMLButtonElement).click();
    await flushPromises();

    expect(window.electron.git.respondToCredentialRequest).toHaveBeenCalledWith('r1', null);
    expect(problem()).toContain(`Push needs you to sign in to ${HOST}.`);

    // Not a four-second toast: it is still there later.
    await new Promise((resolve) => setTimeout(resolve, 4100));
    expect(problem()).toContain('sign in');
  }, 10_000);

  it('says the server refused the login, and "Try again" asks again', async () => {
    await clickPush();
    await signIn({ username: 'alice', password: 'wrong' });
    expect(problem()).toContain(`Push failed: ${HOST} refused the login.`);

    const retry = [...document.body.querySelectorAll('[data-testid="git-sign-in-problem"] button')]
      .find((b) => b.textContent?.trim() === 'Try again') as HTMLButtonElement;
    retry.click();
    await flushPromises();

    expect(pushes).toBe(2);
    expect(problem()).toBeNull();
    await signIn(RIGHT);
    expect(problem()).toBeNull();
  });
});
