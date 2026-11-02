<script setup lang="ts">
/**
 * The claude.ai connectors: the services set up on the claude.ai account
 * Claude Code is signed in with (Gmail, Google Drive, …), how each stands,
 * and what can be done about it.
 *
 * Claude Code connects them in every conversation by itself. One that waits
 * for authorising gives Claude nothing but a way to authorise it, and that
 * is announced to Claude mid-conversation — which it then tends to mention,
 * out of the blue. So each can be authorised from here (on claude.ai) or
 * turned off for the project.
 */

import { computed, onMounted, watch } from 'vue';
import { storeToRefs } from 'pinia';

import type { ClaudeAiConnector } from '@shared/types';

import { useMcpStore } from '../../stores/mcp';
import Button from '../shared/Button.vue';
import Icon from '../shared/Icon.vue';

const mcpStore = useMcpStore();
const {
  hasProject,
  connectors,
  connectorsAvailable,
  isCheckingConnectors,
  connectorBusy,
  connectorsAuthorising,
  connectorsError,
} = storeToRefs(mcpStore);

onMounted(() => {
  void mcpStore.checkConnectors();
});

// Turning one off is per project, so a different project reads differently.
watch(hasProject, () => {
  void mcpStore.checkConnectors();
});

const STATUS: Record<ClaudeAiConnector['status'], { label: string; classes: string }> = {
  connected: { label: 'Connected', classes: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300' },
  'needs-auth': { label: 'Needs authorising', classes: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300' },
  failed: { label: 'Failed', classes: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300' },
  pending: { label: 'Connecting…', classes: 'bg-surface-200 dark:bg-surface-700 text-surface-600 dark:text-surface-300' },
  disabled: { label: 'Off in this project', classes: 'bg-surface-200 dark:bg-surface-700 text-surface-500 dark:text-surface-400' },
};

/** "claude.ai Gmail" reads as "Gmail" under a claude.ai heading. */
function displayName(connector: ClaudeAiConnector): string {
  return connector.name.replace(/^claude\.ai\s+/, '');
}

const firstCheck = computed(() => connectors.value === null);
</script>

<template>
  <div
    v-if="hasProject"
    class="claude-ai-connectors mt-4"
  >
    <div class="flex items-start justify-between gap-3 mb-2">
      <div>
        <h4 class="text-sm font-medium text-surface-700 dark:text-surface-300">
          claude.ai connectors
        </h4>
        <p class="text-xs text-surface-500 dark:text-surface-400 mt-0.5">
          Services connected to your claude.ai account. Claude uses them in every conversation;
          one that needs authorising only lets Claude ask you to authorise it.
        </p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        :loading="isCheckingConnectors"
        :disabled="isCheckingConnectors || connectorBusy !== null"
        @click="mcpStore.checkConnectors()"
      >
        Check again
      </Button>
    </div>

    <div
      v-if="connectorsError"
      class="mb-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-800 dark:text-red-200 flex items-start gap-2"
    >
      <Icon
        name="error"
        size="xs"
        class="mt-0.5 shrink-0"
      />
      <span>{{ connectorsError }}</span>
    </div>

    <div
      v-if="firstCheck && isCheckingConnectors"
      class="text-xs text-surface-500 dark:text-surface-400 py-2"
    >
      Checking… this starts Claude Code briefly and takes a few seconds.
    </div>

    <div
      v-else-if="!connectorsAvailable"
      class="p-3 rounded-lg border border-dashed border-surface-300 dark:border-surface-600 text-xs text-surface-500 dark:text-surface-400"
    >
      Sign in to Claude to see the connectors of your claude.ai account.
    </div>

    <div
      v-else-if="connectors && connectors.length === 0"
      class="p-3 rounded-lg border border-dashed border-surface-300 dark:border-surface-600 text-xs text-surface-500 dark:text-surface-400"
    >
      No claude.ai connectors. They come with a claude.ai sign-in, and are added on claude.ai.
    </div>

    <ul
      v-else-if="connectors"
      class="space-y-2"
    >
      <li
        v-for="connector in connectors"
        :key="connector.name"
        class="connector p-3 rounded-lg border border-surface-300 dark:border-surface-600"
        :data-connector="connector.name"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <!-- Name and status each stay whole: Settings is narrow, and a
                 badge broken over two lines read as two badges. -->
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span class="text-sm font-medium text-surface-800 dark:text-surface-200 whitespace-nowrap">
                {{ displayName(connector) }}
              </span>
              <span
                class="connector-status text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded whitespace-nowrap"
                :class="STATUS[connector.status].classes"
              >
                {{ STATUS[connector.status].label }}
              </span>
            </div>
            <p
              v-if="connector.status === 'connected' && connector.toolCount !== undefined"
              class="text-xs text-surface-500 dark:text-surface-400 mt-1"
            >
              {{ connector.toolCount }} {{ connector.toolCount === 1 ? 'tool' : 'tools' }} for Claude
            </p>
            <p
              v-else-if="connector.status === 'failed' && connector.error"
              class="text-xs text-red-700 dark:text-red-300 mt-1 break-words"
            >
              {{ connector.error }}
            </p>
            <p
              v-else-if="connector.status === 'needs-auth' && connectorsAuthorising.includes(connector.name)"
              class="text-xs text-surface-600 dark:text-surface-300 mt-1"
            >
              Finish on the claude.ai page that opened in your browser, then press Check again.
            </p>
          </div>

          <div class="flex items-center gap-1 shrink-0">
            <Button
              v-if="connector.status === 'needs-auth'"
              variant="secondary"
              size="sm"
              :loading="connectorBusy === connector.name"
              :disabled="connectorBusy !== null || isCheckingConnectors"
              @click="mcpStore.authorizeConnector(connector.name)"
            >
              Authorise
            </Button>
            <Button
              v-if="connector.status !== 'pending'"
              variant="ghost"
              size="sm"
              :disabled="connectorBusy !== null || isCheckingConnectors"
              @click="mcpStore.setConnectorEnabled(connector.name, connector.status === 'disabled')"
            >
              {{ connector.status === 'disabled' ? 'Turn on' : 'Turn off' }}
            </Button>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>
