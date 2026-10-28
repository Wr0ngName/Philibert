<script setup lang="ts">
/**
 * Signing in to a git server during a push or pull.
 *
 * Git asks for a login when none of the user's credential helpers has one
 * (see GitCredentialBroker). The answer goes back to git and nowhere else:
 * Philibert keeps nothing. When it works, git hands it to the user's own
 * credential helper, which is what remembers it — the same as a sign-in in
 * a terminal.
 *
 * Closing the dialog cancels the sign-in, and the push or pull then fails
 * saying so.
 */

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

import type { GitCredentialRequest } from '@shared/types';

import Button from './Button.vue';
import Modal from './Modal.vue';

/** Requests in the order git made them; the first is the one shown. */
const queue = ref<GitCredentialRequest[]>([]);
const current = computed(() => queue.value[0] ?? null);

const username = ref('');
const password = ref('');
const usernameInput = ref<HTMLInputElement | null>(null);
const passwordInput = ref<HTMLInputElement | null>(null);

const canSubmit = computed(() => username.value.trim() !== '' && password.value !== '');

let cleanup: (() => void) | null = null;

watch(current, async (request) => {
  username.value = request?.username ?? '';
  password.value = '';
  if (!request) return;
  await nextTick();
  (request.username ? passwordInput.value : usernameInput.value)?.focus();
});

function answer(login: { username: string; password: string } | null): void {
  const request = current.value;
  if (!request) return;
  queue.value = queue.value.slice(1);
  void window.electron.git.respondToCredentialRequest(request.requestId, login);
}

function submit(): void {
  if (!canSubmit.value) return;
  answer({ username: username.value.trim(), password: password.value });
}

onMounted(() => {
  cleanup = window.electron.git.onCredentialRequest((request) => {
    queue.value = [...queue.value, request];
  });
});

onUnmounted(() => {
  cleanup?.();
  // Nothing left to answer them: git would otherwise wait for its timeout.
  for (const request of queue.value) {
    void window.electron.git.respondToCredentialRequest(request.requestId, null);
  }
});
</script>

<template>
  <Modal
    :open="current !== null"
    :title="current ? `Sign in to ${current.host}` : ''"
    size="sm"
    @close="answer(null)"
  >
    <form
      v-if="current"
      class="space-y-3"
      data-testid="git-credential-form"
      @submit.prevent="submit"
    >
      <p class="text-sm text-surface-600 dark:text-surface-300">
        Git needs a login for {{ current.protocol ? `${current.protocol}://` : '' }}{{ current.host }}.
        Use an access token as the password if your server requires one.
      </p>
      <label class="block space-y-1">
        <span class="text-xs font-medium text-surface-600 dark:text-surface-400">Username</span>
        <input
          ref="usernameInput"
          v-model="username"
          type="text"
          autocomplete="username"
          class="w-full px-2.5 py-1.5 text-sm rounded-md border border-surface-300 dark:border-surface-600 bg-surface-50 dark:bg-surface-900 text-surface-800 dark:text-surface-200 focus:outline-hidden focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
        >
      </label>
      <label class="block space-y-1">
        <span class="text-xs font-medium text-surface-600 dark:text-surface-400">Password or access token</span>
        <input
          ref="passwordInput"
          v-model="password"
          type="password"
          autocomplete="current-password"
          class="w-full px-2.5 py-1.5 text-sm rounded-md border border-surface-300 dark:border-surface-600 bg-surface-50 dark:bg-surface-900 text-surface-800 dark:text-surface-200 focus:outline-hidden focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
        >
      </label>
      <p class="text-xs text-surface-500 dark:text-surface-400">
        Philibert does not keep it; your git credential helper does, if you have one.
      </p>
      <div class="flex justify-end gap-2 pt-1">
        <Button
          variant="ghost"
          size="sm"
          @click="answer(null)"
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          type="submit"
          :disabled="!canSubmit"
        >
          Sign in
        </Button>
      </div>
    </form>
  </Modal>
</template>
