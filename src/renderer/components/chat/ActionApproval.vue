<script setup lang="ts">
/**
 * Action approval component - shows pending actions for user approval.
 * Presents per-scope permission buttons (session/project/global) when
 * the SDK provides scope-specific suggestions.
 */

import { computed, onMounted, onUnmounted, ref } from 'vue';

import { SANDBOXED_SHELL_SUMMARY, UNSANDBOXED_SHELL_SUMMARY } from '@shared/sandbox';
import type { PendingAction, FileEditDetails, BashCommandDetails, GenericToolDetails, PermissionOptionVariant, PermissionScope, PermissionScopeOption, PermissionContext } from '@shared/types';
import type { IconName } from '../shared/Icon.vue';

import Button from '../shared/Button.vue';
import Icon from '../shared/Icon.vue';

interface Props {
  /** The pending action requiring user approval */
  action: PendingAction;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'approve', actionId: string, alwaysAllow?: boolean, chosenScope?: PermissionScope, chosenVariant?: PermissionOptionVariant): void;
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

/**
 * The broadest scope option: the last in scope order, leaving out a scope's
 * narrow option ("this exact command"), which grants the least.
 */
const broadestScopeOption = computed(() => {
  const broad = scopeOptions.value.filter((o) => !o.variant);
  return broad.length > 0 ? broad[broad.length - 1] : null;
});

/**
 * What allowing a shell tool whole at this scope lets through, when it is
 * more than the sandbox keeps in: a grant for this session in a discussion
 * running unsandboxed, or one saved for the project or everywhere — those
 * outlive this discussion's sandbox, and apply as well to discussions that
 * run without one. Null when the option needs no confirming: a narrow one
 * (this command), a session grant inside the sandbox, or a tool that is not
 * a shell.
 */
function broadShellGrant(option: PermissionScopeOption): string | null {
  const shell = props.action.shell;
  if (!shell || option.variant) return null;
  const tool = props.action.toolName;
  if (option.scope === 'session') {
    return shell.sandboxed
      ? null
      : `This lets Claude run any ${tool} command in this discussion without asking, unsandboxed: it can read, change or delete anything your account can, anywhere on this computer.`;
  }
  const where = option.scope === 'project' ? 'in every discussion of this project' : 'in every discussion';
  return `This lets Claude run any ${tool} command ${where} without asking — saved, not only for this discussion. In a discussion running unsandboxed, that means anything your account can do, anywhere on this computer.`;
}

/** The option waiting for a second click, with what it lets through. */
const confirming = ref<{ option: PermissionScopeOption; warning: string } | null>(null);

/** Allow at an option's scope; one that grants a shell broadly asks to be confirmed first (broadShellGrant). */
function choose(option: PermissionScopeOption): void {
  const warning = broadShellGrant(option);
  if (warning && confirming.value?.option !== option) {
    confirming.value = { option, warning };
    return;
  }
  confirming.value = null;
  emit('approve', props.action.id, true, option.scope, option.variant);
}

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

  if ((event.key === 'Enter' && event.shiftKey) || event.key === 'A') {
    // Neither "always" shortcut on an ask that may only be allowed once.
    if (props.action.onceOnly) return;
  }

  if (event.key === 'Enter' && event.shiftKey) {
    // Shift+Enter = broadest scope always allow
    event.preventDefault();
    if (broadestScopeOption.value) {
      choose(broadestScopeOption.value);
    } else {
      emit('approve', props.action.id, true);
    }
  } else if (event.key === 'Enter' || event.key === 'a') {
    event.preventDefault();
    emit('approve', props.action.id, false);
  } else if (event.key === 's' && hasScopeOptions.value) {
    // 's' = allow for session
    const sessionOption = scopeOptions.value.find((o) => o.scope === 'session' && !o.variant);
    if (sessionOption) {
      event.preventDefault();
      choose(sessionOption);
    }
  } else if (event.key === 'p' && hasScopeOptions.value) {
    // 'p' = allow for project
    const projectOption = scopeOptions.value.find((o) => o.scope === 'project' && !o.variant);
    if (projectOption) {
      event.preventDefault();
      choose(projectOption);
    }
  } else if (event.key === 'A' && !event.shiftKey) {
    // Capital A = broadest scope always allow
    event.preventDefault();
    if (broadestScopeOption.value) {
      choose(broadestScopeOption.value);
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

/**
 * Friendlier rewrite of common SDK decisionReason text.
 *
 * The SDK's auto-classifier reports `Command contains malformed syntax that
 * cannot be parsed: Command too long for parsing (X bytes). Maximum supported
 * length is Y bytes.` when a Bash/PowerShell command exceeds the parser's
 * size cap. That phrasing reads as "Claude is asking to run malformed code"
 * — but the command itself is fine; the *classifier* just bailed out. Reword
 * to make the actual situation clear.
 */
const displayedDecisionReason = computed((): string => {
  const raw = permissionContext.value?.decisionReason ?? '';
  const tooLongMatch = raw.match(/Command too long for parsing \((\d+)\s*bytes?\)\.\s*Maximum supported length is (\d+)\s*bytes?/i);
  if (tooLongMatch) {
    const [, actual, limit] = tooLongMatch;
    return `Auto-approval skipped: command is ${actual} bytes (SDK classifier limit ${limit}). Review and approve manually.`;
  }
  return raw;
});

/**
 * The inputDescription is already woven into the card title (e.g.
 * `PowerShell: Re-run parse...`), so we don't show it a second time as a
 * subtitle. We only render it separately if it's somehow missing from the
 * title (e.g. very long descriptions that got truncated with `…`).
 */
const showInputDescription = computed((): boolean => {
  const details = genericToolDetails.value;
  if (!details?.inputDescription) return false;
  return !props.action.description.includes(details.inputDescription.slice(0, 40));
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
  } else if (!props.action.onceOnly) {
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

    <!-- How a shell command runs: in the sandbox, or anywhere -->
    <div
      v-if="action.shell"
      :class="['rounded-lg p-2.5 mb-2 text-xs border', action.shell.sandboxed
        ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
        : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300']"
      data-testid="shell-sandbox-banner"
    >
      <div>{{ action.shell.sandboxed ? SANDBOXED_SHELL_SUMMARY : UNSANDBOXED_SHELL_SUMMARY }}</div>
      <div
        v-if="action.shell.escapeRefused"
        class="mt-1"
        data-testid="shell-escape-refused"
      >
        Claude asked to run this outside the sandbox. This discussion does not allow that, so it runs inside.
        To let commands out, turn the sandbox off for this discussion in its permissions menu (the shield).
      </div>
    </div>

    <!-- A sandboxed command asking for a host -->
    <div
      v-if="action.networkHost"
      class="rounded-lg p-2.5 mb-2 text-xs border bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300"
      data-testid="network-host-banner"
    >
      A sandboxed command wants to connect to <span class="font-mono">{{ action.networkHost }}</span>.
      Allowing it for the session or project lets this discussion's commands, and web fetches, reach that host.
    </div>

    <!-- Permission context (why this was triggered) -->
    <div
      v-if="hasPermissionContext"
      class="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-2.5 mb-2 text-xs"
    >
      <div
        v-if="displayedDecisionReason"
        class="text-amber-800 dark:text-amber-300"
      >
        {{ displayedDecisionReason }}
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
          v-if="showInputDescription"
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

    <!-- A broad shell grant, waiting for a second click -->
    <div
      v-if="confirming"
      class="rounded-lg p-2.5 mb-2 text-xs border bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300"
      role="alert"
      data-testid="broad-shell-confirm"
    >
      <div>{{ confirming.warning }}</div>
      <div class="flex gap-2 justify-end mt-2">
        <Button
          variant="secondary"
          size="sm"
          @click="confirming = null"
        >
          Cancel
        </Button>
        <Button
          variant="danger"
          size="sm"
          data-testid="broad-shell-confirm-yes"
          @click="choose(confirming.option)"
        >
          {{ confirming.option.label }}
        </Button>
      </div>
    </div>

    <!-- Actions -->
    <div class="flex gap-2 justify-end items-center flex-wrap">
      <Button
        variant="danger"
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
          :key="`${option.scope}:${option.variant ?? ''}`"
          variant="secondary"
          size="sm"
          :title="option.description"
          :aria-label="`${option.label} - ${option.description}`"
          @click="choose(option)"
        >
          <span
            :class="['inline-block w-2 h-2 rounded-full mr-1.5', scopeDotClass(option.scope)]"
            :title="scopeTitle(option.scope)"
          />
          {{ option.label }}
        </Button>
      </template>

      <!-- Fallback single button (when no scope options). None at all when
           the CLI asked for this to be allowed once at most. -->
      <Button
        v-else-if="!action.onceOnly"
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
