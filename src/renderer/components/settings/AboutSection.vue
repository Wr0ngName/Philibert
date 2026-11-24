<script setup lang="ts">
/**
 * The About tab of settings — what this installation is made of.
 *
 * Every value comes from the running installation rather than a build
 * constant, so it is useful in a bug report: the bundled CLI's installed
 * version, the whisper binary's own reported version, and the runtime's own
 * numbers. A value that could not be determined shows as "unknown" rather
 * than being hidden, because a missing component is the thing worth noticing.
 *
 * And a check for an update, on demand: the app checks by itself when it
 * starts and every day, and this says what a check finds now. An update it
 * finds is offered by the update banner, as one found by itself is.
 */

import { ref, computed, watch } from 'vue';

import type { AboutInfo, UpdateCheckResult } from '@shared/types';

import { logger } from '../../utils/logger';
import Button from '../shared/Button.vue';
import Icon from '../shared/Icon.vue';
import Spinner from '../shared/Spinner.vue';

interface Props {
  /** Whether the tab is shown; the information is read each time it is. */
  active: boolean;
}

const props = defineProps<Props>();

const info = ref<AboutInfo | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const copied = ref(false);
const checkingForUpdate = ref(false);
/** What the last check asked for here found; null before one. */
const updateCheck = ref<UpdateCheckResult | null>(null);
const updateCheckError = ref<string | null>(null);

async function checkForUpdate(): Promise<void> {
  checkingForUpdate.value = true;
  updateCheckError.value = null;
  try {
    updateCheck.value = await window.electron.update.check();
  } catch (cause) {
    updateCheck.value = null;
    updateCheckError.value = cause instanceof Error ? cause.message : String(cause);
    logger.error('Failed to check for updates', { error: cause });
  } finally {
    checkingForUpdate.value = false;
  }
}

/** What the check found, in words. */
const updateCheckText = computed((): string | null => {
  if (updateCheckError.value) return `Could not check: ${updateCheckError.value}`;
  const result = updateCheck.value;
  if (!result) return null;
  switch (result.status) {
    case 'available':
      return `Version ${result.update.version} is available: the banner at the top of the window downloads it.`;
    case 'up-to-date':
      return `Philibert is up to date (newest release: ${result.latestVersion}).`;
    case 'pending':
      return result.downloaded
        ? `Version ${result.version} is downloaded: the banner at the top of the window installs it.`
        : `Version ${result.version} is downloading.`;
    case 'failed':
      switch (result.reason) {
        case 'no-release':
          return 'No release was found on your update channel.';
        case 'unsupported-install':
          return `Version ${result.version} is out, but this installation cannot update itself: download it from the repository's releases.`;
        case 'no-feed':
          return `Version ${result.version} is out, but has no update for this platform yet.`;
        case 'error':
          return `Could not check: ${result.message || 'the update server did not answer'}.`;
      }
  }
  return null;
});

// Read when the tab is shown rather than on mount: it spawns the whisper
// binary to ask its version, which is not worth doing for a tab that may
// never be looked at.
watch(
  () => props.active,
  async (active) => {
    if (!active) return;
    loading.value = true;
    error.value = null;
    copied.value = false;
    try {
      info.value = await window.electron.about.getInfo();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Could not read version information';
      logger.error('Failed to load About info', { error: cause });
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

/** A value, or an explicit "unknown" so a missing component is visible. */
function shown(value: string | null | undefined): string {
  return value && value.trim() ? value : 'unknown';
}

interface Row {
  label: string;
  value: string;
}

interface Group {
  title: string;
  rows: Row[];
}

const groups = computed((): Group[] => {
  const i = info.value;
  if (!i) return [];
  const runtime: Row[] = [
    { label: 'Electron', value: shown(i.electronVersion) },
    { label: 'Chromium', value: shown(i.chromeVersion) },
    { label: 'Node', value: shown(i.nodeVersion) },
    { label: 'Platform', value: `${i.platform} ${i.arch}` },
  ];
  // Only Windows builds have an online/offline distinction.
  if (i.bundleType) runtime.push({ label: 'Bundle', value: i.bundleType });
  return [
    {
      title: 'Versions',
      rows: [
        { label: 'Philibert', value: shown(i.appVersion) },
        { label: 'Claude Code CLI', value: shown(i.claudeCodeVersion) },
        { label: 'Claude Agent SDK', value: shown(i.agentSdkVersion) },
        { label: 'whisper.cpp', value: shown(i.whisperVersion) },
      ],
    },
    { title: 'Runtime', rows: runtime },
    {
      title: 'Locations',
      rows: [
        { label: 'User data', value: i.userDataPath },
        { label: 'Log file', value: i.logPath },
        // Shown even when missing, because its absence is what explains
        // dictation being unavailable.
        { label: 'Speech binary', value: i.whisperBinaryPath ?? 'not bundled in this build' },
      ],
    },
  ];
});

/**
 * Open the repository in the user's browser.
 *
 * Goes through window.open rather than a new IPC call: the main process
 * already installs a window-open handler that hands every such request to
 * shell.openExternal and denies the in-app window, so this is the existing
 * route for external links.
 */
function openRepository(): void {
  const url = info.value?.repositoryUrl;
  if (!url) return;
  window.open(url, '_blank', 'noopener');
}

/**
 * Copy everything as plain text, which is the point of the tab: it saves
 * transcribing a dozen version numbers into a bug report by hand.
 */
async function copyAll(): Promise<void> {
  const i = info.value;
  if (!i) return;

  const lines = groups.value.flatMap(group => group.rows).map(row => `${row.label}: ${row.value}`);
  if (i.repositoryUrl) lines.push(`Repository: ${i.repositoryUrl}`);
  if (i.license) lines.push(`License: ${i.license}`);

  try {
    // Through the main process; see MessageItem.copyContent for why.
    await window.electron.clipboard.writeText(lines.join('\n'));
    copied.value = true;
  } catch (cause) {
    // Leave the button state alone rather than claiming success, and say why
    // rather than failing silently.
    logger.error('Failed to copy the about information', cause);
  }
}
</script>

<template>
  <div
    v-if="loading"
    class="flex items-center gap-2 p-4 text-sm text-surface-500"
  >
    <Spinner size="sm" />
    Reading version information…
  </div>

  <div
    v-else-if="error"
    class="p-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg"
  >
    {{ error }}
  </div>

  <div
    v-else-if="info"
    class="space-y-4"
  >
    <section
      v-for="group in groups"
      :key="group.title"
    >
      <h3 class="text-xs font-medium text-surface-500 dark:text-surface-400 uppercase tracking-wide mb-2">
        {{ group.title }}
      </h3>
      <dl class="space-y-1">
        <div
          v-for="row in group.rows"
          :key="row.label"
          class="flex items-baseline gap-3 text-sm"
        >
          <dt class="w-40 shrink-0 text-surface-500 dark:text-surface-400">
            {{ row.label }}
          </dt>
          <dd class="min-w-0 break-all font-mono text-xs text-surface-800 dark:text-surface-200">
            {{ row.value }}
          </dd>
        </div>
      </dl>
    </section>

    <section
      class="pt-3 border-t border-surface-200 dark:border-surface-700 flex flex-wrap items-center gap-3"
      data-testid="about-updates"
    >
      <div class="flex-1 min-w-0 text-sm">
        <p
          v-if="updateCheckText"
          class="text-surface-800 dark:text-surface-200"
          data-testid="update-check-result"
        >
          {{ updateCheckText }}
        </p>
        <p class="text-xs text-surface-500 dark:text-surface-400">
          Philibert checks for updates when it starts, then every day.
        </p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        :disabled="checkingForUpdate"
        data-testid="check-for-updates"
        @click="checkForUpdate"
      >
        <Spinner
          v-if="checkingForUpdate"
          size="xs"
          class="mr-1"
        />
        <Icon
          v-else
          name="refresh"
          size="xs"
          class="mr-1"
        />
        {{ checkingForUpdate ? 'Checking…' : 'Check for updates' }}
      </Button>
    </section>

    <section class="pt-3 border-t border-surface-200 dark:border-surface-700 flex flex-wrap items-center gap-3">
      <span
        v-if="info.license"
        class="text-xs text-surface-500 dark:text-surface-400"
      >{{ info.license }} licensed</span>
      <div class="ml-auto flex items-center gap-2">
        <Button
          v-if="info.repositoryUrl"
          variant="secondary"
          size="sm"
          :title="info.repositoryUrl"
          @click="openRepository"
        >
          <Icon
            name="external-link"
            size="xs"
            class="mr-1"
          />
          Repository
        </Button>
        <Button
          variant="secondary"
          size="sm"
          @click="copyAll"
        >
          <Icon
            :name="copied ? 'check' : 'document'"
            size="xs"
            class="mr-1"
          />
          {{ copied ? 'Copied' : 'Copy details' }}
        </Button>
      </div>
    </section>
  </div>
</template>
