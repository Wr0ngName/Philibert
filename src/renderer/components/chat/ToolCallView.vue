<script setup lang="ts">
/**
 * A tool call: its input and its output, as both detail views show one —
 * Tool Details for a call in the discussion, and the background task view
 * for a command running in the background.
 *
 * `live` is for output that is still being written: the view follows its end
 * as text arrives, unless the reader has scrolled up to read something, and
 * then stays where they are.
 */

import { computed, nextTick, ref, watch } from 'vue';

import { imageOnlyResultText } from '@shared/tool-images';
import type { BackgroundTask, MessageImage } from '@shared/types';

import { formatTokenCount } from '../../utils/token-count';
import { formatToolInput } from '../../utils/tool-input';
import { formatToolOutput, type ToolCallOutput } from '../../utils/tool-output';
import Icon from '../shared/Icon.vue';
import Spinner from '../shared/Spinner.vue';
import AgentLink from './AgentLink.vue';
import MessageImages from './MessageImages.vue';

interface Props {
  /** The call's input; no Input section when there is none to show. */
  input?: Record<string, unknown> | null;
  /** The tool, named next to the Input heading. */
  toolName?: string;
  /** No Output section when null. */
  output: ToolCallOutput | null;
  live?: boolean;
  /**
   * Images the call produced — a Read of an image file, a rendered page —
   * and the conversation whose store holds their bytes.
   */
  images?: MessageImage[];
  conversationId?: string;
  /**
   * Agents the input names by id, by the input field naming each — the agent
   * a SendMessage call writes to. Shown as the agent, not as its id.
   */
  agents?: Record<string, BackgroundTask>;
  /**
   * Fit the height it is given, all of it, instead of each block stopping at
   * a height of its own: each block as tall as its text, and when they are
   * more than the room, each shrunk in proportion to its height — a long
   * output gets most of it — scrolling within itself, down to 4rem. Headings
   * and one-line values keep their height: everything is one column of its
   * own (the sections `display: contents`), so shrinking reaches the blocks
   * only, and a short input is not crushed by a long output. For a dialog
   * the user resized (Modal's `sized`); without it, the blocks fit their
   * text up to a height, as in a dialog sized to its content.
   */
  fill?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  input: undefined,
  toolName: undefined,
  live: false,
  images: undefined,
  conversationId: undefined,
  agents: () => ({}),
  fill: false,
});

const emit = defineEmits<{
  /** Show the details of an agent the input names. */
  (e: 'open-agent', taskId: string): void;
}>();

const hasImages = computed(() => (props.images?.length ?? 0) > 0 && !!props.conversationId);

/**
 * Whether the text output only says the result is images ("[image]"). It is
 * there for views that show text alone; next to the images it is a tag
 * repeating what is on screen, so it is left out.
 */
const textOnlyNamesImages = computed(() =>
  hasImages.value
  && props.output?.kind === 'text'
  && props.output.text.trim() === imageOnlyResultText(props.images!.length),
);

const inputParams = computed(() => formatToolInput(props.input));

/** At most this many lines, and this many characters (wrapped lines), a block's text is short. */
const SHORT_BLOCK_LINES = 3;
const SHORT_BLOCK_CHARS = 240;

/**
 * A block's height when filling (`fill`): a short text keeps its own — never
 * shrunk, nor made taller than it — a longer one shrinks to share the room,
 * down to a few lines.
 */
function filledBlock(text: string | null): string {
  const short = text !== null && text.length <= SHORT_BLOCK_CHARS && text.split('\n').length <= SHORT_BLOCK_LINES;
  return short ? 'shrink-0' : 'min-h-16';
}

/** Output text, pretty-printed when it is JSON. */
const outputText = computed(() =>
  props.output?.kind === 'text' ? formatToolOutput(props.output.text) : null,
);

const skippedBytes = computed(() =>
  props.output?.kind === 'text' ? props.output.skippedBytes ?? 0 : 0,
);

const outputRef = ref<HTMLElement | null>(null);
const FOLLOW_THRESHOLD_PX = 24;
let following = true;

function onOutputScroll(): void {
  const el = outputRef.value;
  if (!el) return;
  following = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD_PX;
}

watch(outputText, () => {
  if (!props.live || !following) return;
  void nextTick(() => {
    const el = outputRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
});

// Output read afresh — another call, or the same one reopened — starts
// followed again.
watch(() => props.output?.kind, (kind) => {
  if (kind === 'loading') following = true;
});
</script>

<template>
  <div :class="fill ? 'flex flex-col gap-2 h-full min-h-0' : 'space-y-4'">
    <div
      v-if="inputParams.length > 0"
      :class="fill ? 'contents' : 'space-y-3'"
      data-testid="tool-call-input"
    >
      <div class="text-xs font-medium text-surface-500 dark:text-surface-400 flex items-center gap-2">
        <Icon
          name="code"
          size="xs"
        />
        <span>Input</span>
        <span
          v-if="toolName"
          class="font-mono text-surface-400 dark:text-surface-500"
        >{{ toolName }}</span>
      </div>

      <div
        v-for="param in inputParams"
        :key="param.key"
        :class="fill ? 'contents' : 'space-y-1'"
      >
        <!-- Short values on one line… -->
        <div
          v-if="!param.isBlock"
          class="flex items-baseline gap-2 text-xs"
        >
          <span class="font-medium text-surface-500 dark:text-surface-400 shrink-0">{{ param.label }}</span>
          <AgentLink
            v-if="agents[param.key]"
            :agent="agents[param.key]"
            @open="emit('open-agent', $event)"
          />
          <span
            v-else
            class="font-mono text-surface-800 dark:text-surface-200 break-all"
          >{{ param.value }}</span>
        </div>

        <!-- …code and content as a block. -->
        <template v-else>
          <div class="text-xs font-medium text-surface-500 dark:text-surface-400">
            {{ param.label }}
          </div>
          <div :class="['code-block !p-3 overflow-y-auto', fill ? filledBlock(param.value) : 'max-h-60']">
            <pre class="text-xs text-surface-800 dark:text-surface-200 whitespace-pre-wrap">{{ param.value }}</pre>
          </div>
        </template>
      </div>
    </div>

    <div
      v-if="output || hasImages"
      :class="fill ? 'contents' : 'space-y-2'"
      data-testid="tool-call-output"
    >
      <div :class="['text-xs font-medium text-surface-500 dark:text-surface-400 flex items-center gap-2', { 'mt-2': fill }]">
        <Icon
          name="document"
          size="xs"
        />
        <span>Output</span>
        <span
          v-if="skippedBytes > 0"
          class="text-surface-400 dark:text-surface-500"
        >— the last part only; {{ formatTokenCount(skippedBytes) }}B before it not shown</span>
      </div>

      <!-- What the tool produced as images, drawn as the discussion draws them. -->
      <MessageImages
        v-if="hasImages"
        :conversation-id="conversationId!"
        :images="images!"
      />

      <template v-if="output">
        <div
          v-if="output.kind === 'loading'"
          class="flex items-center gap-2 p-3 text-xs text-surface-500"
        >
          <Spinner size="xs" />
          Loading output…
        </div>
        <div
          v-else-if="output.kind === 'error'"
          class="text-xs text-red-500 p-3 bg-red-50 dark:bg-red-900/20 rounded-lg"
        >
          Failed to load output: {{ output.message }}
        </div>
        <div
          v-else-if="output.kind === 'text' && !textOnlyNamesImages"
          ref="outputRef"
          :class="['code-block !p-3 overflow-y-auto', fill ? filledBlock(outputText) : 'max-h-96']"
          @scroll="onOutputScroll"
        >
          <pre class="text-xs text-surface-800 dark:text-surface-200 whitespace-pre-wrap">{{ outputText }}</pre>
        </div>
        <div
          v-else-if="output.kind === 'note'"
          class="text-xs text-surface-400 dark:text-surface-500 italic"
        >
          {{ output.message }}
        </div>
      </template>
    </div>
  </div>
</template>
