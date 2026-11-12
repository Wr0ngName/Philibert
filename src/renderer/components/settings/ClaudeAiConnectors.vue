<script setup lang="ts">
/**
 * The claude.ai connectors: the services set up on the claude.ai account
 * Claude Code is signed in with (Gmail, Google Drive, …), how each stands,
 * and what can be done about it — in every project at once.
 *
 * Claude Code connects them in every conversation by itself. One that waits
 * for authorising gives Claude nothing but a way to authorise it, and that
 * is announced to Claude mid-conversation — which it then tends to mention,
 * out of the blue. So each can be authorised from here (on claude.ai), or
 * turned off everywhere; a project can also turn one off for itself
 * (Settings → Project).
 *
 * Also lists what else is off everywhere and is no tool of the user's own —
 * a project's server turned off in Claude Code's settings, say — so it can be
 * turned back on from here too.
 */

import { computed } from 'vue';
import { storeToRefs } from 'pinia';

import type { GlobalToolStatus } from '@shared/types';

import { useMcpStore } from '../../stores/mcp';
import { connectorRows, displayName, otherOffEverywhere } from '../../utils/global-tools';
import Button from '../shared/Button.vue';
import Icon from '../shared/Icon.vue';

const mcpStore = useMcpStore();
const { globalTools, isCheckingGlobal, toolBusy, connectorsAuthorising, globalError } = storeToRefs(mcpStore);

const STATUS: Record<GlobalToolStatus['status'], { label: string; classes: string }> = {
  connected: { label: 'Connected', classes: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300' },
  'needs-auth': { label: 'Needs authorising', classes: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300' },
  failed: { label: 'Failed', classes: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300' },
  pending: { label: 'Connecting…', classes: 'bg-surface-200 dark:bg-surface-700 text-surface-600 dark:text-surface-300' },
  disabled: { label: 'Off', classes: 'bg-surface-200 dark:bg-surface-700 text-surface-500 dark:text-surface-400' },
};
const OFF_EVERYWHERE = { label: 'Off everywhere', classes: 'bg-surface-200 dark:bg-surface-700 text-surface-500 dark:text-surface-400' };

const firstCheck = computed(() => globalTools.value === null);
/** Whether a session could be started to check them at all — no sign-in, no session. */
const available = computed(() => globalTools.value?.statuses !== null);
const rows = computed(() => (globalTools.value ? connectorRows(globalTools.value) : []));
const others = computed(() => (globalTools.value ? otherOffEverywhere(globalTools.value) : []));
const busy = computed(() => toolBusy.value !== null || isCheckingGlobal.value);
</script>

<template>
  <div class="claude-ai-connectors">
    <div class="flex items-start justify-between gap-3 mb-2">
      <div>
        <h3 class="text-sm font-medium text-surface-700 dark:text-surface-300">
          claude.ai connectors
        </h3>
        <p class="text-xs text-surface-500 dark:text-surface-400 mt-0.5">
          Services connected to your claude.ai account. Claude uses them in every project;
          one that needs authorising only lets Claude ask you to authorise it.
        </p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        :loading="isCheckingGlobal"
        :disabled="busy"
        @click="mcpStore.checkGlobalTools()"
      >
        Check again
      </Button>
    </div>

    <div
      v-if="globalError"
      class="mb-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-800 dark:text-red-200 flex items-start gap-2"
    >
      <Icon
        name="error"
        size="xs"
        class="mt-0.5 shrink-0"
      />
      <span>{{ globalError }}</span>
    </div>

    <div
      v-if="firstCheck && isCheckingGlobal"
      class="text-xs text-surface-500 dark:text-surface-400 py-2"
    >
      Checking… this starts Claude Code briefly and takes a few seconds.
    </div>

    <div
      v-else-if="!available"
      class="p-3 rounded-lg border border-dashed border-surface-300 dark:border-surface-600 text-xs text-surface-500 dark:text-surface-400"
    >
      Sign in to Claude to see the connectors of your claude.ai account.
    </div>

    <div
      v-else-if="globalTools && rows.length === 0"
      class="p-3 rounded-lg border border-dashed border-surface-300 dark:border-surface-600 text-xs text-surface-500 dark:text-surface-400"
    >
      No claude.ai connectors. They come with a claude.ai sign-in, and are added on claude.ai.
    </div>

    <ul
      v-else-if="globalTools"
      class="space-y-2"
    >
      <li
        v-for="row in rows"
        :key="row.name"
        class="connector p-3 rounded-lg border border-surface-300 dark:border-surface-600"
        :data-connector="row.name"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <!-- Name and status each stay whole: Settings is narrow, and a
                 badge broken over two lines read as two badges. -->
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span class="text-sm font-medium text-surface-800 dark:text-surface-200 whitespace-nowrap">
                {{ displayName(row.name) }}
              </span>
              <span
                class="connector-status text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded whitespace-nowrap"
                :class="row.offEverywhere || !row.status ? OFF_EVERYWHERE.classes : STATUS[row.status.status].classes"
              >
                {{ row.offEverywhere || !row.status ? OFF_EVERYWHERE.label : STATUS[row.status.status].label }}
              </span>
            </div>
            <p
              v-if="row.offEverywhere"
              class="text-xs text-surface-500 dark:text-surface-400 mt-1"
            >
              Claude doesn't get it in any project. Turning it back on applies to discussions started after.
            </p>
            <p
              v-else-if="row.status?.status === 'connected' && row.status.toolCount !== undefined"
              class="text-xs text-surface-500 dark:text-surface-400 mt-1"
            >
              {{ row.status.toolCount }} {{ row.status.toolCount === 1 ? 'tool' : 'tools' }} for Claude
            </p>
            <p
              v-else-if="row.status?.status === 'failed' && row.status.error"
              class="text-xs text-red-700 dark:text-red-300 mt-1 break-words"
            >
              {{ row.status.error }}
            </p>
            <p
              v-else-if="row.status?.status === 'needs-auth' && connectorsAuthorising.includes(row.name)"
              class="text-xs text-surface-600 dark:text-surface-300 mt-1"
            >
              Finish on the claude.ai page that opened in your browser, then press Check again.
            </p>
          </div>

          <div class="flex items-center gap-1 shrink-0">
            <Button
              v-if="!row.offEverywhere && row.status?.status === 'needs-auth'"
              variant="secondary"
              size="sm"
              :loading="toolBusy === row.name"
              :disabled="busy"
              @click="mcpStore.authorizeConnector(row.name)"
            >
              Authorise
            </Button>
            <Button
              v-if="row.status?.status !== 'pending'"
              variant="ghost"
              size="sm"
              class="connector-switch"
              :loading="toolBusy === row.name"
              :disabled="busy"
              @click="mcpStore.setOffEverywhere(row.name, !row.offEverywhere)"
            >
              {{ row.offEverywhere ? 'Turn back on' : 'Turn off everywhere' }}
            </Button>
          </div>
        </div>
      </li>
    </ul>

    <div
      v-if="others.length > 0"
      class="other-off-everywhere mt-4"
    >
      <h4 class="text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">
        Also off everywhere
      </h4>
      <ul class="space-y-1">
        <li
          v-for="name in others"
          :key="name"
          class="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-surface-300 dark:border-surface-600"
          :data-off-everywhere="name"
        >
          <span class="text-sm text-surface-700 dark:text-surface-300 truncate">{{ name }}</span>
          <Button
            variant="ghost"
            size="sm"
            :loading="toolBusy === name"
            :disabled="busy"
            @click="mcpStore.setOffEverywhere(name, false)"
          >
            Turn back on
          </Button>
        </li>
      </ul>
    </div>
  </div>
</template>
