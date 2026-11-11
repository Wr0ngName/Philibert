<script setup lang="ts">
/**
 * Settings, one dialog in tabs: the account, how the app looks, the
 * discussions, the tool servers, the advanced settings and what this
 * installation is made of.
 *
 * Every tab stays mounted, hidden when not shown, so Save writes what was
 * changed on any of them, Cancel forgets all of it, and the sign-in form
 * keeps its state while another tab is looked at.
 */

import type { AutoArchiveDays, CompletionNotifications, ExecutionMode, LogLevel, SessionRetention, SidebarLayout, UpdateChannel, WhisperModelId } from '@shared/types';
import { AUTO_ARCHIVE_DAYS, CLAUDE_DEFAULT_SESSION_RETENTION_DAYS, DEFAULT_CONFIG, SESSION_RETENTION_STOPS } from '@shared/types';
import type { SettingsTab } from '@shared/settings-tabs';
import { SETTINGS_TABS } from '@shared/settings-tabs';
import { DEFAULT_WHISPER_MODEL, WHISPER_AUTO_LANGUAGE, WHISPER_MODELS } from '@shared/speech';
import { ref, computed, nextTick, watch, onMounted } from 'vue';
import { storeToRefs } from 'pinia';

import { SETTINGS_DIALOG_SIZE } from '../../constants/layout';
import { useSettingsStore } from '../../stores/settings';
import { useUiStore } from '../../stores/ui';
import { logger } from '../../utils/logger';
import Button from '../shared/Button.vue';
import Modal from '../shared/Modal.vue';
import AuthForm from '../shared/AuthForm.vue';
import ToggleSwitch from '../shared/ToggleSwitch.vue';
import AboutSection from './AboutSection.vue';
import McpServersPanel from './McpServersPanel.vue';

interface Props {
  open: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const settingsStore = useSettingsStore();
const uiStore = useUiStore();
const { config, isSaving } = storeToRefs(settingsStore);

const TAB_LABELS: Record<SettingsTab, string> = {
  account: 'Account',
  appearance: 'Appearance',
  discussions: 'Discussions',
  tools: 'Tool servers',
  advanced: 'Advanced',
  about: 'About',
};

/** The tab shown; kept between opens, so settings reopens where it was left. */
const activeTab = ref<SettingsTab>(SETTINGS_TABS[0]);
const pageScroller = ref<HTMLElement | null>(null);

const tabId = (tab: SettingsTab) => `settings-tab-${tab}`;
const pageId = (tab: SettingsTab) => `settings-page-${tab}`;

function showTab(tab: SettingsTab): void {
  activeTab.value = tab;
}

// Each tab is read from its top: one scrolled down is no place to start another.
watch(activeTab, () => {
  if (pageScroller.value) pageScroller.value.scrollTop = 0;
});

/** Arrow keys, Home and End move between tabs, as a vertical tab list does. */
function onTabKeydown(event: KeyboardEvent): void {
  const index = SETTINGS_TABS.indexOf(activeTab.value);
  const last = SETTINGS_TABS.length - 1;
  const targets: Record<string, number> = {
    ArrowDown: index === last ? 0 : index + 1,
    ArrowUp: index === 0 ? last : index - 1,
    Home: 0,
    End: last,
  };
  const target = targets[event.key];
  if (target === undefined) return;
  event.preventDefault();
  const tab = SETTINGS_TABS[target];
  showTab(tab);
  void nextTick(() => document.getElementById(tabId(tab))?.focus());
}

// A command that opens settings for one of its tabs (`/login`, `/mcp`) turns
// to it; consumed, so a later open does not turn to it again.
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const tab = uiStore.takeSettingsTab();
    if (tab) showTab(tab);
  },
  { immediate: true },
);

/** The classes of a choice among several, chosen or not. */
function choiceClasses(chosen: boolean): string {
  return chosen
    ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
    : 'border-surface-300 dark:border-surface-600 text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700';
}

// Local form state
const localTheme = ref<'light' | 'dark' | 'system'>('system');
const localSidebarLayout = ref<SidebarLayout>(DEFAULT_CONFIG.sidebarLayout);
const localAutoArchiveDays = ref<AutoArchiveDays>(DEFAULT_CONFIG.autoArchiveDays);
const localFontSize = ref(14);
const localLineHeight = ref(1.6);
const localLogLevel = ref<LogLevel>('info');
const localEnableNotifications = ref(true);
const localCompletionNotifications = ref<CompletionNotifications>('all-done');
const localAutoContinueAtUsageLimit = ref(true);
const localUpdateChannel = ref<UpdateChannel>('stable');
const localExecutionMode = ref<ExecutionMode>('sdk');
const localSpeechEnabled = ref(false);
const localSpeechModel = ref<WhisperModelId>(DEFAULT_WHISPER_MODEL);
const localSpeechLanguage = ref(WHISPER_AUTO_LANGUAGE);
const authFormRef = ref<InstanceType<typeof AuthForm>>();

/** Whether this build ships a whisper binary, and which models are cached. */
const speechAvailable = ref(false);
const downloadedModels = ref<WhisperModelId[]>([]);
const speechModels = WHISPER_MODELS;

onMounted(async () => {
  const availability = await window.electron.speech.getAvailability();
  speechAvailable.value = availability.available;
  downloadedModels.value = availability.downloadedModels;
});

/** Download size as whole megabytes — exact bytes are noise at this scale. */
function formatModelSize(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

const isOAuthUser = computed(() =>
  authFormRef.value?.authStatus?.method === 'oauth' &&
  authFormRef.value?.authStatus?.isAuthenticated === true
);

/** The sidebar layouts, each with a sketch of the row: D discussions, F files, the conversation between bars. */
const sidebarLayoutOptions: { value: SidebarLayout; label: string; sketch: string }[] = [
  { value: 'left', label: 'Both left', sketch: 'D F | Chat' },
  { value: 'split', label: 'Either side', sketch: 'D | Chat | F' },
  { value: 'right', label: 'Both right', sketch: 'Chat | F D' },
];

/** A number of days as the sliders say it. */
const DAY_LABELS: Record<number, string> = {
  7: '1 week',
  14: '2 weeks',
  30: '1 month',
  60: '2 months',
  90: '3 months',
  180: '6 months',
  365: '1 year',
  730: '2 years',
  3650: '10 years',
};
function daysLabel(days: number): string {
  return DAY_LABELS[days] ?? `${days} days`;
}

/** The archive slider's stops, a week to a year; 0, never, is the switch beside it. */
type ArchiveAfter = Exclude<AutoArchiveDays, 0>;
const archiveStops = AUTO_ARCHIVE_DAYS.filter((days): days is ArchiveAfter => days !== 0);

/**
 * The delay last set on the slider, so turning archiving off and back on
 * returns to it rather than to the default.
 */
const lastArchiveAfter = ref<ArchiveAfter>(DEFAULT_CONFIG.autoArchiveDays as ArchiveAfter);

const autoArchiveOn = computed({
  get: () => localAutoArchiveDays.value !== 0,
  set: (on: boolean) => {
    localAutoArchiveDays.value = on ? lastArchiveAfter.value : 0;
    if (on) keepSessionsLongerThanArchive();
  },
});

/** The slider's position: an index into archiveStops. */
const archiveStopIndex = computed({
  get: () => archiveStops.indexOf(lastArchiveAfter.value),
  set: (index: number) => {
    lastArchiveAfter.value = archiveStops[index];
    localAutoArchiveDays.value = lastArchiveAfter.value;
    keepSessionsLongerThanArchive();
  },
});

/*
 * How long Claude Code keeps sessions (`cleanupPeriodDays`, in its own user
 * settings). A discussion whose session it deleted has nothing left to
 * continue and is archived for good, so archiving is only of use before
 * then: the two sliders move each other to keep archiving the shorter.
 */
/** As read when the dialog opened; null until then. */
const sessionRetention = ref<SessionRetention | null>(null);
const localRetentionDays = ref<number>(CLAUDE_DEFAULT_SESSION_RETENTION_DAYS);
/** Why the retention could not be saved, shown until the next try. */
const retentionError = ref<string | null>(null);

/** The retention slider's stops; one set outside the app that is not among them becomes one. */
const retentionStops = computed(() => {
  const loaded = sessionRetention.value?.status === 'unreadable' ? undefined : sessionRetention.value?.days;
  const stops: number[] = [...SESSION_RETENTION_STOPS];
  if (loaded !== undefined && !stops.includes(loaded)) stops.push(loaded);
  return stops.sort((a, b) => a - b);
});

const retentionStopIndex = computed({
  get: () => retentionStops.value.indexOf(localRetentionDays.value),
  set: (index: number) => {
    localRetentionDays.value = retentionStops.value[index];
    archiveBeforeSessionsGo();
  },
});

/** Archiving set to the session retention or later: the archived could never be brought back. */
const archiveOutlivesSessions = computed(
  () => autoArchiveOn.value && sessionRetention.value?.status !== 'unreadable' && localAutoArchiveDays.value >= localRetentionDays.value,
);

/** Archiving moved past the retention: the retention goes to the next stop after it. */
function keepSessionsLongerThanArchive(): void {
  if (sessionRetention.value?.status === 'unreadable') return;
  if (localAutoArchiveDays.value < localRetentionDays.value) return;
  const longer = retentionStops.value.find((days) => days > localAutoArchiveDays.value);
  if (longer !== undefined) localRetentionDays.value = longer;
}

/** The retention moved down to archiving: archiving goes to the last stop before it, or off. */
function archiveBeforeSessionsGo(): void {
  if (!autoArchiveOn.value || localAutoArchiveDays.value < localRetentionDays.value) return;
  const shorter = [...archiveStops].reverse().find((days) => days < localRetentionDays.value);
  if (shorter === undefined) {
    localAutoArchiveDays.value = 0;
    return;
  }
  lastArchiveAfter.value = shorter;
  localAutoArchiveDays.value = shorter;
}

async function loadSessionRetention(): Promise<void> {
  retentionError.value = null;
  try {
    sessionRetention.value = await window.electron.claude.getSessionRetention();
  } catch (error) {
    logger.warn("Failed to read Claude Code's session retention", { error });
    sessionRetention.value = { status: 'unreadable' };
  }
  if (sessionRetention.value.status !== 'unreadable') localRetentionDays.value = sessionRetention.value.days;
}

/** Write the retention when it was changed. @returns false when that failed. */
async function saveSessionRetention(): Promise<boolean> {
  const loaded = sessionRetention.value;
  if (!loaded || loaded.status === 'unreadable' || loaded.days === localRetentionDays.value) return true;
  try {
    sessionRetention.value = await window.electron.claude.setSessionRetention(localRetentionDays.value);
    retentionError.value = null;
    return true;
  } catch (error) {
    logger.error("Failed to set Claude Code's session retention", { error });
    retentionError.value = "Claude Code's settings could not be written; nothing was changed there.";
    return false;
  }
}

/** Take the archive setting from the config, slider position included. */
function loadAutoArchive(days: AutoArchiveDays): void {
  localAutoArchiveDays.value = days;
  if (days !== 0) lastArchiveAfter.value = days;
}

// Log level options for the selector
const logLevelOptions: { value: LogLevel; label: string; description: string }[] = [
  { value: 'error', label: 'Error', description: 'Only errors' },
  { value: 'warn', label: 'Warning', description: 'Warnings and errors' },
  { value: 'info', label: 'Info', description: 'General information' },
  { value: 'debug', label: 'Debug', description: 'Detailed debugging' },
];

const completionNotificationOptions: { value: CompletionNotifications; label: string; description: string }[] = [
  {
    value: 'all-done',
    label: 'When everything is done',
    description: 'Once Claude has finished and no background task is still running',
  },
  {
    value: 'each',
    label: 'Each reply and task',
    description: 'Every time Claude finishes replying, and every time a background task ends',
  },
];

const executionModeOptions: { value: ExecutionMode; label: string; description: string }[] = [
  { value: 'sdk', label: 'SDK', description: 'Credit pool billing, full features' },
  { value: 'channel', label: 'Channel', description: 'Subscription billing, no credit cap' },
];

const updateChannelOptions: { value: UpdateChannel; label: string; description: string }[] = [
  { value: 'stable', label: 'Stable', description: 'Production releases only' },
  { value: 'rc', label: 'Release Candidate', description: 'Test upcoming versions early' },
];

/** Put every field back to what the config says. */
function loadFromConfig(): void {
  const saved = config.value;
  localTheme.value = saved.theme;
  localSidebarLayout.value = saved.sidebarLayout;
  loadAutoArchive(saved.autoArchiveDays);
  localFontSize.value = saved.fontSize;
  localLineHeight.value = saved.lineHeight;
  localLogLevel.value = saved.logLevel;
  localEnableNotifications.value = saved.enableNotifications;
  localCompletionNotifications.value = saved.completionNotifications;
  localAutoContinueAtUsageLimit.value = saved.autoContinueAtUsageLimit;
  localUpdateChannel.value = saved.updateChannel;
  localExecutionMode.value = saved.executionMode;
  localSpeechEnabled.value = saved.speechEnabled;
  localSpeechModel.value = saved.speechModel;
  localSpeechLanguage.value = saved.speechLanguage;
}

// Sync with the store whenever the config changes
watch(() => config.value, loadFromConfig, { immediate: true });

// Refresh auth status when the dialog opens
watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      await authFormRef.value?.refreshAuthStatus();
      authFormRef.value?.resetState();
    }
  }
);

// Read afresh at each opening: it is Claude Code's, and can change outside the app.
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) void loadSessionRetention();
  },
  { immediate: true },
);

async function saveSettings() {
  // First, and alone if it fails: the dialog stays open on the reason.
  if (!(await saveSessionRetention())) return;
  // Save theme (also applies it), font size, and log level
  await settingsStore.setTheme(localTheme.value);
  await settingsStore.setSidebarLayout(localSidebarLayout.value);
  await settingsStore.setAutoArchiveDays(localAutoArchiveDays.value);
  await settingsStore.setFontSize(localFontSize.value);
  await settingsStore.setLineHeight(localLineHeight.value);
  await settingsStore.setLogLevel(localLogLevel.value);
  await settingsStore.setEnableNotifications(localEnableNotifications.value);
  await settingsStore.setCompletionNotifications(localCompletionNotifications.value);
  await settingsStore.setAutoContinueAtUsageLimit(localAutoContinueAtUsageLimit.value);
  await settingsStore.setUpdateChannel(localUpdateChannel.value);
  const effectiveMode = config.value.authMethod === 'oauth' ? localExecutionMode.value : 'sdk';
  await settingsStore.setExecutionMode(effectiveMode);
  await settingsStore.setSpeechEnabled(localSpeechEnabled.value);
  await settingsStore.setSpeechModel(localSpeechModel.value);
  // An empty box means "detect it" rather than an empty language code.
  await settingsStore.setSpeechLanguage(localSpeechLanguage.value.trim() || WHISPER_AUTO_LANGUAGE);

  emit('close');
}

function cancel() {
  loadFromConfig();
  retentionError.value = null;
  if (sessionRetention.value && sessionRetention.value.status !== 'unreadable') {
    localRetentionDays.value = sessionRetention.value.days;
  }
  authFormRef.value?.resetState();
  emit('close');
}
</script>

<template>
  <Modal
    :open="open"
    title="Settings"
    size="3xl"
    resize-key="settings"
    :default-size="SETTINGS_DIALOG_SIZE"
    @close="cancel"
  >
    <div class="flex h-full min-h-0 gap-6">
      <div
        role="tablist"
        aria-label="Settings"
        aria-orientation="vertical"
        class="w-40 shrink-0 flex flex-col gap-1"
      >
        <button
          v-for="tab in SETTINGS_TABS"
          :id="tabId(tab)"
          :key="tab"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab"
          :aria-controls="pageId(tab)"
          :tabindex="activeTab === tab ? 0 : -1"
          :class="[
            'px-3 py-2 rounded-lg text-left text-sm transition-colors',
            activeTab === tab
              ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300 font-medium'
              : 'text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700',
          ]"
          @click="showTab(tab)"
          @keydown="onTabKeydown"
        >
          {{ TAB_LABELS[tab] }}
        </button>
      </div>

      <div
        ref="pageScroller"
        class="flex-1 min-w-0 overflow-y-auto pr-1"
      >
        <!-- Account -->
        <div
          v-show="activeTab === 'account'"
          :id="pageId('account')"
          role="tabpanel"
          :aria-labelledby="tabId('account')"
          class="space-y-6"
        >
          <AuthForm
            ref="authFormRef"
            :show-title="true"
          />

          <!-- Usage limit -->
          <div>
            <label class="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
              Usage Limit
            </label>
            <div class="flex items-center justify-between gap-4 p-3 rounded-lg border border-surface-300 dark:border-surface-600">
              <div class="flex-1">
                <div class="text-sm font-medium text-surface-700 dark:text-surface-300">
                  Continue automatically at usage limit
                </div>
                <div class="text-xs text-surface-500 dark:text-surface-400 mt-1">
                  When a claude.ai usage limit stops a task, wait for the limit to reset and continue
                  it. When off, the wait is offered as a choice instead.
                </div>
              </div>
              <ToggleSwitch
                v-model="localAutoContinueAtUsageLimit"
                label="Toggle continuing automatically at usage limit"
              />
            </div>
          </div>
        </div>

        <!-- Appearance -->
        <div
          v-show="activeTab === 'appearance'"
          :id="pageId('appearance')"
          role="tabpanel"
          :aria-labelledby="tabId('appearance')"
          class="space-y-6"
        >
          <div>
            <label class="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
              Theme
            </label>
            <div class="flex gap-2">
              <button
                v-for="option in ['light', 'dark', 'system'] as const"
                :key="option"
                :class="['flex-1 px-4 py-2 rounded-lg border text-sm font-medium capitalize transition-colors', choiceClasses(localTheme === option)]"
                @click="localTheme = option"
              >
                {{ option }}
              </button>
            </div>
          </div>

          <!-- Where the sidebars sit -->
          <div>
            <label
              id="sidebar-layout-label"
              class="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2"
            >
              Layout
            </label>
            <div
              class="flex gap-2"
              role="radiogroup"
              aria-labelledby="sidebar-layout-label"
            >
              <button
                v-for="option in sidebarLayoutOptions"
                :key="option.value"
                role="radio"
                :aria-checked="localSidebarLayout === option.value"
                :class="['flex-1 px-3 py-2 rounded-lg border text-sm transition-colors', choiceClasses(localSidebarLayout === option.value)]"
                @click="localSidebarLayout = option.value"
              >
                <span class="block font-mono text-xs mb-1">{{ option.sketch }}</span>
                <span class="block font-medium">{{ option.label }}</span>
              </button>
            </div>
          </div>

          <div>
            <label
              for="font-size"
              class="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2"
            >
              Font Size: {{ localFontSize }}px
            </label>
            <input
              id="font-size"
              v-model.number="localFontSize"
              type="range"
              min="12"
              max="20"
              step="1"
              class="w-full h-2 bg-surface-200 dark:bg-surface-700 rounded-lg appearance-none cursor-pointer"
            >
            <div class="flex justify-between text-xs text-surface-400 mt-1">
              <span>12px</span>
              <span>20px</span>
            </div>
          </div>

          <div>
            <label
              for="line-height"
              class="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2"
            >
              Line Spacing: {{ localLineHeight.toFixed(1) }}
            </label>
            <input
              id="line-height"
              v-model.number="localLineHeight"
              type="range"
              min="1.0"
              max="2.4"
              step="0.1"
              class="w-full h-2 bg-surface-200 dark:bg-surface-700 rounded-lg appearance-none cursor-pointer"
            >
            <div class="flex justify-between text-xs text-surface-400 mt-1">
              <span>Compact</span>
              <span>Spacious</span>
            </div>
          </div>
        </div>

        <!-- Discussions -->
        <div
          v-show="activeTab === 'discussions'"
          :id="pageId('discussions')"
          role="tabpanel"
          :aria-labelledby="tabId('discussions')"
          class="space-y-6"
        >
          <!-- Archiving inactive discussions -->
          <div>
            <label class="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
              Archive
            </label>
            <div class="p-3 rounded-lg border border-surface-300 dark:border-surface-600">
              <div class="flex items-center justify-between gap-4">
                <div class="flex-1">
                  <div class="text-sm font-medium text-surface-700 dark:text-surface-300">
                    Archive inactive discussions
                  </div>
                  <div class="text-xs text-surface-500 dark:text-surface-400 mt-1">
                    They move to Archived in the discussions list. Bring one back from there to write in it again.
                  </div>
                </div>
                <ToggleSwitch
                  v-model="autoArchiveOn"
                  label="Toggle archiving inactive discussions"
                />
              </div>
              <div
                v-if="autoArchiveOn"
                class="mt-4"
              >
                <label
                  for="auto-archive-after"
                  class="block text-sm text-surface-700 dark:text-surface-300 mb-2"
                >
                  After {{ daysLabel(lastArchiveAfter) }} without a message
                </label>
                <input
                  id="auto-archive-after"
                  v-model.number="archiveStopIndex"
                  type="range"
                  min="0"
                  :max="archiveStops.length - 1"
                  step="1"
                  :aria-valuetext="daysLabel(lastArchiveAfter)"
                  class="w-full h-2 bg-surface-200 dark:bg-surface-700 rounded-lg appearance-none cursor-pointer"
                >
                <div class="flex justify-between text-xs text-surface-400 mt-1">
                  <span>{{ daysLabel(archiveStops[0]) }}</span>
                  <span>{{ daysLabel(archiveStops[archiveStops.length - 1]) }}</span>
                </div>
              </div>

              <!-- How long Claude Code keeps sessions -->
              <div class="session-retention mt-4 pt-4 border-t border-surface-200 dark:border-surface-700">
                <div class="text-sm font-medium text-surface-700 dark:text-surface-300">
                  Keep Claude's sessions
                </div>
                <div class="text-xs text-surface-500 dark:text-surface-400 mt-1">
                  Claude Code deletes a session after this long without use. A discussion whose session is gone
                  can't be continued: it is archived for good. This is Claude Code's own setting, so it also
                  applies to Claude Code in a terminal.
                </div>
                <p
                  v-if="sessionRetention?.status === 'unreadable'"
                  class="retention-unreadable mt-3 text-xs text-amber-700 dark:text-amber-300"
                >
                  Claude Code's settings file could not be read, so this can't be shown or changed here.
                </p>
                <div
                  v-else-if="sessionRetention"
                  class="mt-3"
                >
                  <label
                    for="session-retention"
                    class="block text-sm text-surface-700 dark:text-surface-300 mb-2"
                  >
                    For {{ daysLabel(localRetentionDays) }}{{ sessionRetention.status === 'default' && localRetentionDays === sessionRetention.days ? " (Claude Code's default)" : '' }}
                  </label>
                  <input
                    id="session-retention"
                    v-model.number="retentionStopIndex"
                    type="range"
                    min="0"
                    :max="retentionStops.length - 1"
                    step="1"
                    :aria-valuetext="daysLabel(localRetentionDays)"
                    class="w-full h-2 bg-surface-200 dark:bg-surface-700 rounded-lg appearance-none cursor-pointer"
                  >
                  <div class="flex justify-between text-xs text-surface-400 mt-1">
                    <span>{{ daysLabel(retentionStops[0]) }}</span>
                    <span>{{ daysLabel(retentionStops[retentionStops.length - 1]) }}</span>
                  </div>
                  <p
                    v-if="archiveOutlivesSessions"
                    class="archive-outlives-sessions mt-3 text-xs text-amber-700 dark:text-amber-300"
                  >
                    Discussions are archived after {{ daysLabel(localAutoArchiveDays) }}, when Claude Code has
                    deleted their session or is about to: they could not be brought back. Keep sessions longer,
                    or archive sooner.
                  </p>
                </div>
                <p
                  v-if="retentionError"
                  class="retention-error mt-3 text-xs text-red-600 dark:text-red-400"
                  role="alert"
                >
                  {{ retentionError }}
                </p>
              </div>
            </div>
          </div>

          <!-- Notifications -->
          <div>
            <label class="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
              System Notifications
            </label>
            <div class="flex items-center justify-between gap-4 p-3 rounded-lg border border-surface-300 dark:border-surface-600">
              <div class="flex-1">
                <div class="text-sm font-medium text-surface-700 dark:text-surface-300">
                  Desktop Notifications
                </div>
                <div class="text-xs text-surface-500 dark:text-surface-400 mt-1">
                  Show notifications when window is not focused
                </div>
              </div>
              <ToggleSwitch
                v-model="localEnableNotifications"
                label="Toggle desktop notifications"
              />
            </div>
            <div
              v-if="localEnableNotifications"
              class="flex gap-2 mt-2"
              role="radiogroup"
              aria-label="When to notify that Claude has finished"
            >
              <button
                v-for="option in completionNotificationOptions"
                :key="option.value"
                :class="['flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition-colors text-left', choiceClasses(localCompletionNotifications === option.value)]"
                role="radio"
                :aria-checked="localCompletionNotifications === option.value"
                @click="localCompletionNotifications = option.value"
              >
                <div class="font-medium">
                  {{ option.label }}
                </div>
                <div class="text-xs opacity-75">
                  {{ option.description }}
                </div>
              </button>
            </div>
          </div>

          <!-- Dictation. Hidden entirely when this build has no whisper binary,
               rather than offered and failing on click. -->
          <div v-if="speechAvailable">
            <label class="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
              Dictation
            </label>
            <div class="flex items-center justify-between gap-4 mb-3">
              <div class="flex-1">
                <div class="text-sm text-surface-700 dark:text-surface-300">
                  Microphone input
                </div>
                <div class="text-xs text-surface-500 dark:text-surface-400">
                  Transcribed on this machine — the recording is never uploaded.
                  The first use downloads the selected model.
                </div>
              </div>
              <ToggleSwitch
                v-model="localSpeechEnabled"
                label="Toggle microphone input"
              />
            </div>

            <template v-if="localSpeechEnabled">
              <label class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">
                Model
              </label>
              <div class="grid grid-cols-2 gap-2 mb-3">
                <button
                  v-for="model in speechModels"
                  :key="model.id"
                  :class="['px-3 py-2 rounded-lg border text-sm font-medium transition-colors text-left', choiceClasses(localSpeechModel === model.id)]"
                  @click="localSpeechModel = model.id"
                >
                  <div class="font-medium">
                    {{ model.label }}
                  </div>
                  <div class="text-xs opacity-75">
                    {{ formatModelSize(model.approxBytes) }}
                    <template v-if="downloadedModels.includes(model.id)">
                      · downloaded
                    </template>
                  </div>
                </button>
              </div>

              <label
                for="speech-language"
                class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1"
              >
                Language
              </label>
              <input
                id="speech-language"
                v-model="localSpeechLanguage"
                class="input-base"
                :placeholder="WHISPER_AUTO_LANGUAGE"
              >
              <div class="text-xs text-surface-500 dark:text-surface-400 mt-1">
                A language code such as <code>en</code> or <code>fr</code>, or
                <code>auto</code> to detect it. English-only models ignore this.
              </div>
            </template>
          </div>
        </div>

        <!-- Tool servers (MCP) for the active project -->
        <div
          v-show="activeTab === 'tools'"
          :id="pageId('tools')"
          role="tabpanel"
          :aria-labelledby="tabId('tools')"
        >
          <McpServersPanel />
        </div>

        <!-- Advanced -->
        <div
          v-show="activeTab === 'advanced'"
          :id="pageId('advanced')"
          role="tabpanel"
          :aria-labelledby="tabId('advanced')"
          class="space-y-6"
        >
          <!-- Execution Mode (OAuth/Pro/Max users only) -->
          <div
            v-if="isOAuthUser"
            class="settings-execution-mode"
          >
            <label class="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
              Execution Mode
            </label>
            <div class="flex gap-2">
              <button
                v-for="option in executionModeOptions"
                :key="option.value"
                :class="['flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition-colors text-left', choiceClasses(localExecutionMode === option.value)]"
                @click="localExecutionMode = option.value"
              >
                <div class="font-medium">
                  {{ option.label }}
                </div>
                <div class="text-xs opacity-75">
                  {{ option.description }}
                </div>
              </button>
            </div>
            <div
              v-if="localExecutionMode === 'channel'"
              class="mt-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-200"
            >
              Channel mode uses your Pro/Max subscription for billing with no credit cap.
              Trade-offs: no real-time streaming (replies arrive complete), no mid-session model switching.
              Takes effect on the next new conversation.
            </div>
          </div>

          <div>
            <label class="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
              Update Channel
            </label>
            <div class="flex gap-2">
              <button
                v-for="option in updateChannelOptions"
                :key="option.value"
                :class="['flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition-colors text-left', choiceClasses(localUpdateChannel === option.value)]"
                @click="localUpdateChannel = option.value"
              >
                <div class="font-medium">
                  {{ option.label }}
                </div>
                <div class="text-xs opacity-75">
                  {{ option.description }}
                </div>
              </button>
            </div>
          </div>

          <div>
            <label class="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
              Log Level
            </label>
            <div class="grid grid-cols-2 gap-2">
              <button
                v-for="option in logLevelOptions"
                :key="option.value"
                :class="['px-3 py-2 rounded-lg border text-sm font-medium transition-colors text-left', choiceClasses(localLogLevel === option.value)]"
                @click="localLogLevel = option.value"
              >
                <div class="font-medium">
                  {{ option.label }}
                </div>
                <div class="text-xs opacity-75">
                  {{ option.description }}
                </div>
              </button>
            </div>
          </div>
        </div>

        <!-- About -->
        <div
          v-show="activeTab === 'about'"
          :id="pageId('about')"
          role="tabpanel"
          :aria-labelledby="tabId('about')"
        >
          <AboutSection :active="open && activeTab === 'about'" />
        </div>
      </div>
    </div>

    <template #footer>
      <Button
        variant="ghost"
        @click="cancel"
      >
        Cancel
      </Button>
      <Button
        variant="primary"
        :loading="isSaving"
        @click="saveSettings"
      >
        Save Changes
      </Button>
    </template>
  </Modal>
</template>
