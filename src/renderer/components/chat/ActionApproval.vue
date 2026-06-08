<script setup lang="ts">
/**
 * Action approval component - shows pending actions for user approval.
 * Presents per-scope permission buttons (session/project/global) when
 * the SDK provides scope-specific suggestions.
 */

import { computed, onMounted, onUnmounted, ref } from 'vue';

import type { PendingAction, FileEditDetails, BashCommandDetails, GenericToolDetails, PermissionScope, PermissionScopeOption, PermissionContext } from '@shared/types';
import type { IconName } from '../shared/Icon.vue';

import Button from '../shared/Button.vue';
import Icon from '../shared/Icon.vue';

interface Props {
  /** The pending action requiring user approval */
  action: PendingAction;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'approve', actionId: string, alwaysAllow?: boolean, chosenScope?: PermissionScope): void;
  (e: 'reject', actionId: string): void;
}>();

// For focus management
const cardRef = ref<HTMLElement | null>(null);

/** Per-scope options from SDK permission suggestions */
const scopeOptions = computed((): PermissionScopeOption[] => {
  return props.action.permissionInfo?.scopeOptions ?? [];
});

/** Whether we have per-scope buttons to show */
const hasScopeOptions = computed(() => scopeOptions.value.length > 0);

/** The broadest scope option (last in sorted order) */
const broadestScopeOption = computed(() => {
  if (scopeOptions.value.length > 0) {
    return scopeOptions.value[scopeOptions.value.length - 1];
  }
  return null;
});

/** Fallback label when no scope options */
const fallbackAlwaysAllowLabel = computed(() => {
  return props.action.permissionInfo?.alwaysAllowLabel ?? 'Always Allow';
});

/** Fallback tooltip when no scope options */
const fallbackAlwaysAllowTooltip = computed(() => {
  return props.action.permissionInfo?.description
    ?? 'Approve this action and allow similar actions automatically in the future';
});

/** Color class for a scope dot indicator */
function scopeDotClass(scope: PermissionScope): string {
  switch (scope) {
    case 'session': return 'bg-blue-400';
    case 'project': return 'bg-yellow-400';
    case 'global': return 'bg-green-400';
  }
}

/** Human-readable scope name for tooltips */
function scopeTitle(scope: PermissionScope): string {
  switch (scope) {
    case 'session': return 'Session only';
    case 'project': return 'Project scope';
    case 'global': return 'Global scope';
  }
}

/**
 * Handle keyboard shortcuts for quick action approval/rejection.
 * Enter/a = allow once, s = session scope, p = project scope,
 * Shift+Enter/A = broadest scope, Escape/r = deny
 */
function handleKeydown(event: KeyboardEvent) {
  // Only handle if this action card is focused or contains focus
  if (!cardRef.value?.contains(document.activeElement) && document.activeElement !== cardRef.value) {
    return;
  }

  if (event.key === 'Enter' && event.shiftKey) {
    // Shift+Enter = broadest scope always allow
    event.preventDefault();
    if (broadestScopeOption.value) {
      emit('approve', props.action.id, true, broadestScopeOption.value.scope);
    } else {
      emit('approve', props.action.id, true);
    }
  } else if (event.key === 'Enter' || event.key === 'a') {
    event.preventDefault();
    emit('approve', props.action.id, false);
  } else if (event.key === 's' && hasScopeOptions.value) {
    // 's' = allow for session
    const sessionOption = scopeOptions.value.find((o) => o.scope === 'session');
    if (sessionOption) {
      event.preventDefault();
      emit('approve', props.action.id, true, 'session');
    }
  } else if (event.key === 'p' && hasScopeOptions.value) {
    // 'p' = allow for project
    const projectOption = scopeOptions.value.find((o) => o.scope === 'project');
    if (projectOption) {
      event.preventDefault();
      emit('approve', props.action.id, true, 'project');
    }
  } else if (event.key === 'A' && !event.shiftKey) {
    // Capital A = broadest scope always allow
    event.preventDefault();
    if (broadestScopeOption.value) {
      emit('approve', props.action.id, true, broadestScopeOption.value.scope);
    } else {
      emit('approve', props.action.id, true);
    }
  } else if (event.key === 'Escape' || event.key.toLowerCase() === 'r') {
    event.preventDefault();
    emit('reject', props.action.id);
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown);
  // Focus the card when it appears for keyboard accessibility
  cardRef.value?.focus();
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
});

const isFileAction = computed(() =>
  ['file-edit', 'file-create', 'file-delete'].includes(props.action.type)
);

const isBashAction = computed(() => props.action.type === 'bash-command');
const isGenericToolAction = computed(() => props.action.type === 'generic-tool');

const fileDetails = computed(() => {
  if (isFileAction.value) {
    return props.action.details as FileEditDetails;
  }
  return null;
});

const bashDetails = computed(() => {
  if (isBashAction.value) {
    return props.action.details as BashCommandDetails;
  }
  return null;
});

const genericToolDetails = computed((): GenericToolDetails | null => {
  if (isGenericToolAction.value) {
    return props.action.details as GenericToolDetails;
  }
  return null;
});

const showRawInput = ref(false);

const rawInputJson = computed(() => {
  const details = genericToolDetails.value;
  if (!details) return '';
  try {
    return JSON.stringify(details.rawInput, null, 2);
  } catch {
    return '[unserializable]';
  }
});

const actionIcon = computed((): IconName => {
  switch (props.action.type) {
    case 'file-edit':
      return 'edit';
    case 'file-create':
      return 'document';
    case 'file-delete':
      return 'trash';
    case 'bash-command':
      return 'terminal';
    case 'generic-tool':
      return 'terminal';
    default:
      return 'info';
  }
});

const actionColor = computed(() => {
  switch (props.action.type) {
    case 'file-delete':
      return 'text-red-500';
    case 'bash-command':
    case 'generic-tool':
      return 'text-yellow-500';
    default:
      return 'text-blue-500';
  }
});

/** Permission context from SDK (blockedPath, decisionReason) */
const permissionContext = computed((): PermissionContext | undefined => {
  return props.action.permissionContext;
});

/** Whether we have permission context to display */
const hasPermissionContext = computed(() => {
  return permissionContext.value?.blockedPath || permissionContext.value?.decisionReason;
});

/** Per-scope descriptions for showing detailed permission info */
const scopeDescriptions = computed((): string[] => {
  return scopeOptions.value
    .map((o) => o.description)
    .filter((d) => d.length > 0);
});

/** Keyboard shortcut hint text */
const shortcutHint = computed(() => {
  const parts = ['Enter/a=allow once'];
  if (hasScopeOptions.value) {
    if (scopeOptions.value.some((o) => o.scope === 'session')) parts.push('s=session');
    if (scopeOptions.value.some((o) => o.scope === 'project')) parts.push('p=project');
    parts.push('Shift+Enter/A=broadest');
  } else {
    parts.push('Shift+Enter/A=always allow');
  }
  parts.push('Esc/r=deny');
  return `Keys: ${parts.join(', ')}`;
});
</script>

<template>
  <div
    ref="cardRef"
    class="action-card animate-slide-up outline-hidden focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 dark:focus:ring-offset-surface-800"
    role="alertdialog"
    :aria-labelledby="`action-title-${action.id}`"
    :aria-describedby="`action-desc-${action.id}`"
    tabindex="0"
  >
    <!-- Header -->
    <div class="flex items-start gap-3 mb-3">
      <div
        :class="['shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-yellow-100 dark:bg-yellow-900/30', actionColor]"
        aria-hidden="true"
      >
        <Icon
          :name="actionIcon"
          size="sm"
          aria-hidden="true"
        />
      </div>
      <div class="flex-1">
        <h4
          :id="`action-title-${action.id}`"
          class="font-medium text-surface-900 dark:text-surface-100"
        >
          {{ action.description }}
        </h4>
        <p
          :id="`action-desc-${action.id}`"
          class="text-xs text-surface-500 dark:text-surface-400 mt-0.5"
        >
          {{ shortcutHint }}
        </p>
      </div>
    </div>

    <!-- Permission context (why this was triggered) -->
    <div
      v-if="hasPermissionContext"
      class="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-2.5 mb-2 text-xs"
    >
      <div
        v-if="permissionContext?.decisionReason"
        class="text-amber-800 dark:text-amber-300"
      >
        {{ permissionContext.decisionReason }}
      </div>
      <div
        v-if="permissionContext?.blockedPath"
        class="text-amber-700 dark:text-amber-400 mt-1 font-mono truncate"
      >
        Blocked path: {{ permissionContext.blockedPath }}
      </div>
    </div>

    <!-- Details -->
    <div class="bg-surface-50 dark:bg-surface-900 rounded-lg p-3 mb-2">
      <!-- File details -->
      <template v-if="fileDetails">
        <div class="flex items-center gap-2 text-sm text-surface-600 dark:text-surface-400 mb-2">
          <Icon
            name="document"
            size="sm"
          />
          <span class="font-mono text-xs truncate">{{ fileDetails.filePath }}</span>
        </div>
        <div
          v-if="fileDetails.diff"
          class="code-block text-xs max-h-40 overflow-y-auto"
        >
          <pre>{{ fileDetails.diff }}</pre>
        </div>
      </template>

      <!-- Bash command details -->
      <template v-if="bashDetails">
        <div class="code-block text-xs font-mono whitespace-pre-wrap">
          {{ bashDetails.command }}
        </div>
        <div
          v-if="bashDetails.workingDirectory"
          class="text-xs text-surface-500 dark:text-surface-400 mt-2"
        >
          Working directory: {{ bashDetails.workingDirectory }}
        </div>
      </template>

      <!-- Generic tool details (MCP tools, Task, WebFetch, …) -->
      <template v-if="genericToolDetails">
        <div
          v-if="genericToolDetails.truncated"
          class="text-[11px] text-amber-700 dark:text-amber-300 mb-2"
        >
          Input was truncated by the channel preview limit.
        </div>

        <div
          v-if="genericToolDetails.inputDescription"
          class="text-sm text-surface-700 dark:text-surface-200 mb-2 italic"
        >
          {{ genericToolDetails.inputDescription }}
        </div>

        <div
          v-if="genericToolDetails.primaryText"
          class="mb-2"
        >
          <div class="text-[11px] uppercase tracking-wider text-surface-500 dark:text-surface-400 mb-1">
            {{ genericToolDetails.primaryText.label }}
          </div>
          <pre class="code-block text-xs font-mono whitespace-pre-wrap max-h-60 overflow-auto">{{ genericToolDetails.primaryText.content }}</pre>
        </div>

        <div
          v-if="genericToolDetails.secondaryFields.length > 0"
          class="space-y-1.5"
        >
          <div
            v-for="field in genericToolDetails.secondaryFields"
            :key="field.label"
            class="text-xs"
          >
            <span class="text-surface-500 dark:text-surface-400 font-medium">{{ field.label }}:</span>
            <pre
              v-if="field.multiline"
              class="code-block font-mono whitespace-pre-wrap mt-1 max-h-40 overflow-auto"
            >{{ field.value }}</pre>
            <span
              v-else
              class="font-mono ml-1 break-all text-surface-700 dark:text-surface-200"
            >{{ field.value }}</span>
          </div>
        </div>

        <div
          v-if="genericToolDetails.jsonFields.length > 0"
          class="space-y-1.5 mt-2"
        >
          <div
            v-for="field in genericToolDetails.jsonFields"
            :key="field.label"
            class="text-xs"
          >
            <span class="text-surface-500 dark:text-surface-400 font-medium">{{ field.label }}:</span>
            <pre class="code-block font-mono whitespace-pre-wrap mt-1 max-h-40 overflow-auto">{{ field.json }}</pre>
          </div>
        </div>

        <button
          type="button"
          class="mt-2 text-[11px] text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 underline"
          @click="showRawInput = !showRawInput"
        >
          {{ showRawInput ? 'Hide raw input' : 'Show raw input' }}
        </button>
        <pre
          v-if="showRawInput"
          class="code-block font-mono text-[11px] whitespace-pre-wrap mt-1 max-h-60 overflow-auto"
        >{{ rawInputJson }}</pre>
      </template>
    </div>

    <!-- Permission scope details (what each button will grant) -->
    <div
      v-if="scopeDescriptions.length > 0"
      class="text-xs text-surface-500 dark:text-surface-400 mb-3 px-1 space-y-0.5"
    >
      <div
        v-for="(desc, index) in scopeDescriptions"
        :key="index"
        class="flex items-start gap-1.5"
      >
        <Icon
          name="info"
          size="xs"
          class="shrink-0 mt-0.5"
        />
        <span>{{ desc }}</span>
      </div>
    </div>

    <!-- Actions -->
    <div class="flex gap-2 justify-end items-center flex-wrap">
      <Button
        variant="ghost"
        size="sm"
        @click="emit('reject', action.id)"
      >
        Deny
      </Button>
      <Button
        variant="success"
        size="sm"
        @click="emit('approve', action.id, false)"
      >
        Allow Once
      </Button>

      <!-- Per-scope buttons (when SDK provides scope-specific suggestions) -->
      <template v-if="hasScopeOptions">
        <Button
          v-for="option in scopeOptions"
          :key="option.scope"
          variant="secondary"
          size="sm"
          :title="option.description"
          :aria-label="`${option.label} - ${option.description}`"
          @click="emit('approve', action.id, true, option.scope)"
        >
          <span
            :class="['inline-block w-2 h-2 rounded-full mr-1.5', scopeDotClass(option.scope)]"
            :title="scopeTitle(option.scope)"
          />
          {{ option.label }}
        </Button>
      </template>

      <!-- Fallback single button (when no scope options) -->
      <Button
        v-else
        variant="secondary"
        size="sm"
        :title="fallbackAlwaysAllowTooltip"
        :aria-label="`${fallbackAlwaysAllowLabel} - ${fallbackAlwaysAllowTooltip}`"
        @click="emit('approve', action.id, true)"
      >
        {{ fallbackAlwaysAllowLabel }}
      </Button>
    </div>
  </div>
</template>
