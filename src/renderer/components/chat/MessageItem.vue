<script setup lang="ts">
/**
 * Single message display component
 *
 * In "grouped" mode (inside an assistant turn bubble), renders only
 * the content — no outer bubble wrapper or header, since the parent
 * turn container provides those.
 *
 * Note: v-html usage is safe - content is sanitized with DOMPurify in renderMarkdown
 */

import { computed, ref } from 'vue';

import type { ChatMessage } from '@shared/types';

import { formatTime } from '../../utils/date';
import { renderMarkdown, renderUserMarkdown } from '../../utils/markdown';
import { selectionWithin } from '../../utils/selection';
import BackgroundTaskMessage from './BackgroundTaskMessage.vue';
import ContextMenu, { type ContextMenuItem } from '../shared/ContextMenu.vue';
import Spinner from '../shared/Spinner.vue';
import ToolUseMessage from './ToolUseMessage.vue';

interface Props {
  /** The chat message to display */
  message: ChatMessage;
  /** When true, renders only the inner content (no bubble/header) for use inside a turn container */
  grouped?: boolean;
  /** For tool-use messages: number of sub-agent actions this tool spawned (transitive) */
  childCount?: number;
  /** For tool-use messages: whether the sub-agent group is expanded */
  isExpanded?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  grouped: false,
  childCount: 0,
  isExpanded: false,
});

const emit = defineEmits<{
  (e: 'open-task-detail', taskId: string): void;
  (e: 'open-tool-detail', toolUseBlockId: string): void;
  (e: 'toggle-agent-expand', toolUseId: string): void;
}>();

const isUser = computed(() => props.message.role === 'user');
const isSystem = computed(() => props.message.role === 'system');

// Switch system messages to a wrapping block when the text won't fit on one
// line — short notes like "Model changed to X" keep the centered-with-side-lines
// look; long blobs (e.g. the SDK's auto-deny tool_result text) wrap inline.
const LONG_SYSTEM_MESSAGE_THRESHOLD = 80;
const isLongSystemMessage = computed(
  () =>
    isSystem.value &&
    (props.message.content.length > LONG_SYSTEM_MESSAGE_THRESHOLD ||
      props.message.content.includes('\n')),
);

const formattedTime = computed(() => formatTime(props.message.timestamp));

const renderedContent = computed(() =>
  isUser.value
    ? renderUserMarkdown(props.message.content)
    : renderMarkdown(props.message.content),
);

// Right-click context menu state — opens at the click coordinates, closes on
// outside click / Escape / scroll (handled inside ContextMenu).
const contextMenuOpen = ref(false);
const contextMenuX = ref(0);
const contextMenuY = ref(0);

/**
 * Text selected inside this message when the menu was opened, or null when
 * nothing within it was selected.
 *
 * Captured at open time rather than read in the handler: by the time Copy is
 * activated the selection may be gone, and reading it later also cannot tell
 * whether it belonged to this message or another one.
 */
const selectionAtOpen = ref<string | null>(null);

function openContextMenu(event: MouseEvent): void {
  // Don't override the browser context menu on tool-use / background-task
  // indicators — they're already wrapped components with their own affordances
  // and copying the empty content yields nothing useful.
  if (props.message.toolUse || props.message.backgroundTask) return;
  if (!props.message.content.trim()) return;
  event.preventDefault();

  const container = event.currentTarget;
  selectionAtOpen.value = container instanceof Node ? selectionWithin(container) : null;

  contextMenuX.value = event.clientX;
  contextMenuY.value = event.clientY;
  contextMenuOpen.value = true;
}

async function copyContent(): Promise<void> {
  // Copy what the user actually highlighted. Writing the whole message
  // regardless of the selection is the long-standing behaviour this replaces:
  // highlighting one line of a long reply and hitting Copy pasted the entire
  // reply, with no way to copy a part of it.
  const text = selectionAtOpen.value ?? props.message.content;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard access can be denied in some test/secure contexts; silent.
  }
}

const contextMenuItems = computed<ContextMenuItem[]>(() => [
  // Name which of the two it will be, so the difference is visible before
  // clicking rather than discovered after pasting.
  { label: selectionAtOpen.value ? 'Copy selection' : 'Copy message', onSelect: copyContent },
]);
</script>

<template>
  <!-- System message (e.g. model change notification, SDK denials) -->
  <!-- Short messages keep the centered-with-side-lines look; long messages -->
  <!-- (e.g. SDK auto-deny tool_result text) wrap into a dimmed block instead -->
  <!-- of overflowing horizontally. -->
  <div
    v-if="isSystem"
    :class="[
      'animate-fade-in py-2 px-4',
      isLongSystemMessage
        ? 'flex'
        : 'flex items-center gap-3',
    ]"
    @contextmenu="openContextMenu"
  >
    <template v-if="!isLongSystemMessage">
      <div class="flex-1 h-px bg-surface-200 dark:bg-surface-700" />
      <span class="text-xs text-surface-400 dark:text-surface-500 whitespace-nowrap">
        {{ message.content }}
      </span>
      <div class="flex-1 h-px bg-surface-200 dark:bg-surface-700" />
    </template>
    <span
      v-else
      class="text-xs text-surface-400 dark:text-surface-500 system-message-long"
    >
      {{ message.content }}
    </span>
  </div>

  <!-- Inline tool use indicator -->
  <ToolUseMessage
    v-else-if="message.toolUse"
    :tool-use="message.toolUse"
    :child-count="props.childCount"
    :is-expanded="props.isExpanded"
    @open-detail="emit('open-tool-detail', $event)"
    @toggle-expand="emit('toggle-agent-expand', $event)"
  />

  <!-- Inline background task indicator -->
  <BackgroundTaskMessage
    v-else-if="message.backgroundTask"
    :background-task="message.backgroundTask"
    @open-detail="emit('open-task-detail', $event)"
  />

  <!-- Grouped text content (inside a turn bubble — no wrapper/header) -->
  <div
    v-else-if="grouped && message.content.trim()"
    class="prose prose-sm dark:prose-invert max-w-full text-surface-800 dark:text-surface-200 message-content"
    @contextmenu="openContextMenu"
    v-html="renderedContent"
  />

  <!-- User / standalone assistant message -->
  <div
    v-else-if="!grouped"
    :class="[
      'rounded-lg animate-fade-in message-bubble',
      isUser ? 'message-user' : 'message-assistant',
    ]"
    @contextmenu="openContextMenu"
  >
    <!-- Header -->
    <div class="flex items-center gap-2 message-header">
      <div
        :class="[
          'w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium',
          isUser
            ? 'bg-primary-500 text-white'
            : 'bg-surface-300 dark:bg-surface-600 text-surface-700 dark:text-surface-200',
        ]"
      >
        {{ isUser ? 'U' : 'C' }}
      </div>
      <span class="font-medium text-sm text-surface-700 dark:text-surface-300">
        {{ isUser ? 'You' : 'Claude' }}
      </span>
      <span class="text-xs text-surface-400 dark:text-surface-500">
        {{ formattedTime }}
      </span>
    </div>

    <!-- Content -->
    <div
      class="prose prose-sm dark:prose-invert max-w-full text-surface-800 dark:text-surface-200 message-content"
      v-html="renderedContent"
    />

    <!-- Trailing spinner: sits under the content so it stays visible on long
         streaming answers when the header has scrolled out of view -->
    <div
      v-if="message.isStreaming"
      class="flex items-center gap-2 mt-2"
    >
      <Spinner
        size="sm"
        class="text-primary-500"
      />
    </div>
  </div>

  <ContextMenu
    :open="contextMenuOpen"
    :x="contextMenuX"
    :y="contextMenuY"
    :items="contextMenuItems"
    @close="contextMenuOpen = false"
  />
</template>

<style scoped>
.message-header {
  margin-bottom: calc(var(--chat-line-height, 1.6) * 0.3rem);
}

.message-content {
  font-size: var(--chat-font-size, 14px) !important;
  line-height: var(--chat-line-height, 1.6) !important;
  overflow-wrap: break-word;
  word-break: break-word;
}

/* Force line-height on all prose children (Tailwind Typography sets its own) */
.message-content :deep(*) {
  line-height: inherit !important;
}

/* Code blocks get horizontal scroll instead of overflowing */
.message-content :deep(pre) {
  overflow-x: auto;
  max-width: 100%;
}

/* Scale paragraph spacing with line-height setting */
.message-content :deep(p) {
  margin-top: calc(var(--chat-line-height, 1.6) * 0.3em);
  margin-bottom: calc(var(--chat-line-height, 1.6) * 0.3em);
}

.message-content :deep(p:first-child) {
  margin-top: 0;
}

.message-content :deep(p:last-child) {
  margin-bottom: 0;
}

.system-message-long {
  flex: 1 1 auto;
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: break-word;
  line-height: 1.5;
}
</style>
