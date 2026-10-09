<script setup lang="ts">
/**
 * About dialog — what this installation is made of.
 *
 * Every value comes from the running installation rather than a build
 * constant, so it is useful in a bug report: the bundled CLI's installed
 * version, the whisper binary's own reported version, and the runtime's own
 * numbers. A value that could not be determined shows as "unknown" rather
 * than being hidden, because a missing component is the thing worth noticing.
 */

import { ref, computed, watch } from 'vue';

import type { AboutInfo } from '@shared/types';

import { logger } from '../../utils/logger';
import Button from '../shared/Button.vue';
import Icon from '../shared/Icon.vue';
import Modal from '../shared/Modal.vue';
import Spinner from '../shared/Spinner.vue';

interface Props {
  open: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const info = ref<AboutInfo | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const copied = ref(false);

// Loaded when the dialog opens rather than on mount: it spawns the whisper
// binary to ask its version, which is not worth doing for a dialog that may
// never be opened.
watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return;
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
  /** Rendered monospace — paths and versions read better that way. */
  mono?: boolean;
}

const versionRows = computed((): Row[] => {
  const i = info.value;
  if (!i) return [];
  return [
    { label: 'Philibert', value: shown(i.appVersion), mono: true },
    { label: 'Claude Code CLI', value: shown(i.claudeCodeVersion), mono: true },
    { label: 'Claude Agent SDK', value: shown(i.agentSdkVersion), mono: true },
    { label: 'whisper.cpp', value: shown(i.whisperVersion), mono: true },
  ];
});

const runtimeRows = computed((): Row[] => {
  const i = info.value;
  if (!i) return [];
  const rows: Row[] = [
    { label: 'Electron', value: shown(i.electronVersion), mono: true },
    { label: 'Chromium', value: shown(i.chromeVersion), mono: true },
    { label: 'Node', value: shown(i.nodeVersion), mono: true },
    { label: 'Platform', value: `${i.platform} ${i.arch}`, mono: true },
  ];
  // Only Windows builds have an online/offline distinction.
  if (i.bundleType) {
    rows.push({ label: 'Bundle', value: i.bundleType, mono: true });
  }
  return rows;
});

const pathRows = computed((): Row[] => {
  const i = info.value;
  if (!i) return [];
  const rows: Row[] = [
    { label: 'User data', value: i.userDataPath, mono: true },
    { label: 'Log file', value: i.logPath, mono: true },
  ];
  // Shown when present because its absence is what explains dictation being
  // unavailable, and shown as such when missing for the same reason.
  rows.push({
    label: 'Speech binary',
    value: i.whisperBinaryPath ?? 'not bundled in this build',
    mono: true,
  });
  return rows;
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
 * Copy everything as plain text, which is the point of the dialog: it saves
 * transcribing a dozen version numbers into a bug report by hand.
 */
async function copyAll(): Promise<void> {
  const i = info.value;
  if (!i) return;

  const lines = [
    ...versionRows.value,
    ...runtimeRows.value,
    ...pathRows.value,
  ].map(row => `${row.label}: ${row.value}`);
  if (i.repositoryUrl) lines.push(`Repository: ${i.repositoryUrl}`);
  if (i.license) lines.push(`License: ${i.license}`);

  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    copied.value = true;
  } catch {
    // Clipboard access can be denied; leave the button state alone rather
    // than claiming success.
  }
}
</script>

<template>
  <Modal
    :open="open"
    title="About Philibert"
    size="lg"
    @close="emit('close')"
  >
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
      <section>
        <h3 class="text-xs font-medium text-surface-500 dark:text-surface-400 uppercase tracking-wide mb-2">
          Versions
        </h3>
        <dl class="space-y-1">
          <div
            v-for="row in versionRows"
            :key="row.label"
            class="flex items-baseline gap-3 text-sm"
          >
            <dt class="w-40 shrink-0 text-surface-500 dark:text-surface-400">
              {{ row.label }}
            </dt>
            <dd
              class="min-w-0 break-all text-surface-800 dark:text-surface-200"
              :class="{ 'font-mono text-xs': row.mono }"
            >
              {{ row.value }}
            </dd>
          </div>
        </dl>
      </section>

      <section>
        <h3 class="text-xs font-medium text-surface-500 dark:text-surface-400 uppercase tracking-wide mb-2">
          Runtime
        </h3>
        <dl class="space-y-1">
          <div
            v-for="row in runtimeRows"
            :key="row.label"
            class="flex items-baseline gap-3 text-sm"
          >
            <dt class="w-40 shrink-0 text-surface-500 dark:text-surface-400">
              {{ row.label }}
            </dt>
            <dd
              class="min-w-0 break-all text-surface-800 dark:text-surface-200"
              :class="{ 'font-mono text-xs': row.mono }"
            >
              {{ row.value }}
            </dd>
          </div>
        </dl>
      </section>

      <section>
        <h3 class="text-xs font-medium text-surface-500 dark:text-surface-400 uppercase tracking-wide mb-2">
          Locations
        </h3>
        <dl class="space-y-1">
          <div
            v-for="row in pathRows"
            :key="row.label"
            class="flex items-baseline gap-3 text-sm"
          >
            <dt class="w-40 shrink-0 text-surface-500 dark:text-surface-400">
              {{ row.label }}
            </dt>
            <dd
              class="min-w-0 break-all font-mono text-xs text-surface-800 dark:text-surface-200"
            >
              {{ row.value }}
            </dd>
          </div>
        </dl>
      </section>

      <section
        v-if="info.repositoryUrl || info.license"
        class="pt-3 border-t border-surface-200 dark:border-surface-700 flex items-center justify-between gap-3"
      >
        <div class="min-w-0 text-xs text-surface-500 dark:text-surface-400">
          <span v-if="info.license">{{ info.license }} licensed</span>
        </div>
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
      </section>
    </div>

    <template #footer>
      <div class="flex items-center justify-between gap-2 w-full">
        <Button
          variant="secondary"
          size="sm"
          :disabled="!info"
          @click="copyAll"
        >
          <Icon
            :name="copied ? 'check' : 'document'"
            size="xs"
            class="mr-1"
          />
          {{ copied ? 'Copied' : 'Copy details' }}
        </Button>
        <Button
          variant="primary"
          size="sm"
          @click="emit('close')"
        >
          Close
        </Button>
      </div>
    </template>
  </Modal>
</template>
