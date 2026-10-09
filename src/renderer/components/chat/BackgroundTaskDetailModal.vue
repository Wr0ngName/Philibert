<script setup lang="ts">
/**
 * Background task detail modal (equivalent of Ctrl+O in Claude Code CLI).
 * Shows task description, status, duration, summary, error, and output file content.
 */

import { ref, watch, computed } from 'vue';

import type { BackgroundTask, ToolUseInfo } from '@shared/types';

import type { ActivityRow } from '../../utils/message-tree';
import { formatModelId } from '../../utils/model';
import { formatToolInput, type InputParam } from '../../utils/tool-input';
import Button from '../shared/Button.vue';
import Icon from '../shared/Icon.vue';
import Modal from '../shared/Modal.vue';
import Spinner from '../shared/Spinner.vue';

interface Props {
  open: boolean;
  task: BackgroundTask | null;
  /**
   * The tool call that spawned this task, when there is one.
   *
   * Its input is the detail worth reading — the shell command, or a
   * sub-agent's prompt and type. Without it a running task showed only its
   * description, status and duration, because every other field this modal
   * has (summary, output file, model, tokens) only arrives at the end.
   */
  spawningTool?: ToolUseInfo | null;
  /**
   * Tool calls this task has made, flattened, deepest-nested indented.
   *
   * The task's own fields — summary, output file, model, tokens — are only
   * filled in once it finishes, so for the whole time a task is live this is
   * the only thing there is to show. Without it the modal was an empty
   * "Output:" box.
   */
  activity?: ActivityRow[];
  /** Whether a stop request is in flight. */
  stopping?: boolean;
  /** Why the last stop attempt failed, if it did. */
  stopError?: string | null;
}

const props = withDefaults(defineProps<Props>(), {
  spawningTool: null,
  activity: () => [],
  stopping: false,
  stopError: null,
});

/** The spawning tool's input, formatted the same way the tool modal shows it. */
const inputParams = computed((): InputParam[] => formatToolInput(props.spawningTool?.input));

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'stop', taskId: string): void;
  /** Show one of the task's tool calls in the tool detail modal. */
  (e: 'open-tool-detail', toolUse: ToolUseInfo): void;
}>();

/** Open a tool call's own detail. Guarded: a row without one is not clickable. */
function openToolDetail(toolUse: ToolUseInfo | undefined): void {
  if (toolUse) emit('open-tool-detail', toolUse);
}

// Output file content (lazy-loaded when modal opens)
const outputContent = ref<string | null>(null);
const outputLoading = ref(false);
const outputError = ref<string | null>(null);

// Load output file when modal opens and task has outputFile
watch(
  () => ({ open: props.open, outputFile: props.task?.outputFile }),
  async ({ open, outputFile }) => {
    if (open && outputFile) {
      outputLoading.value = true;
      outputError.value = null;
      outputContent.value = null;
      try {
        outputContent.value = await window.electron.files.read(outputFile);
      } catch (err) {
        outputError.value = err instanceof Error ? err.message : String(err);
      } finally {
        outputLoading.value = false;
      }
    } else if (!open) {
      outputContent.value = null;
      outputError.value = null;
    }
  },
  { immediate: true },
);

const duration = computed(() => {
  if (!props.task) return '';
  const endTime = props.task.completedAt || Date.now();
  const ms = endTime - props.task.startedAt;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
});

/** The model this agent ran on, when the SDK attributed one to it. */
const agentModel = computed(() =>
  props.task?.model ? formatModelId(props.task.model) : null,
);

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Tokens this agent consumed, accumulated across its own frames — attributable
 * to the agent rather than folded into the conversation totals.
 */
const tokenSummary = computed(() => {
  const input = props.task?.inputTokens ?? 0;
  const output = props.task?.outputTokens ?? 0;
  if (input === 0 && output === 0) return null;
  return `${formatTokens(input + output)} tokens`;
});

const tokenTitle = computed(() => {
  const input = props.task?.inputTokens ?? 0;
  const output = props.task?.outputTokens ?? 0;
  return `${input.toLocaleString()} in (including cache reads) / ${output.toLocaleString()} out`;
});

const statusDisplay = computed(() => {
  if (!props.task) return { label: '', colorClass: '' };
  switch (props.task.status) {
    case 'running':
      return { label: 'Running', colorClass: 'text-blue-500' };
    case 'completed':
      return { label: 'Completed', colorClass: 'text-green-500' };
    case 'failed':
      return { label: 'Failed', colorClass: 'text-red-500' };
    case 'stopped':
      return { label: 'Stopped', colorClass: 'text-yellow-500' };
    default:
      return { label: '', colorClass: '' };
  }
});
</script>

<template>
  <Modal
    :open="open"
    title="Background Task Details"
    size="3xl"
    @close="emit('close')"
  >
    <div
      v-if="task"
      class="space-y-4"
    >
      <!-- Status & Description -->
      <div class="flex items-start gap-3">
        <div :class="['shrink-0 mt-0.5', statusDisplay.colorClass]">
          <Spinner
            v-if="task.status === 'running'"
            size="sm"
          />
          <Icon
            v-else-if="task.status === 'completed'"
            name="check-circle"
            size="md"
          />
          <Icon
            v-else-if="task.status === 'failed'"
            name="x-circle"
            size="md"
          />
          <Icon
            v-else
            name="stop"
            size="md"
          />
        </div>
        <div class="flex-1 min-w-0">
          <h3 class="text-sm font-semibold text-surface-900 dark:text-surface-100">
            {{ task.description }}
          </h3>
          <div class="flex items-center gap-3 mt-1 text-xs text-surface-500 dark:text-surface-400">
            <span :class="statusDisplay.colorClass">{{ statusDisplay.label }}</span>
            <span>Duration: {{ duration }}</span>
            <!-- This agent's own model. A sub-agent runs the model named in
                 its definition when it has one and otherwise inherits the
                 main model, so it can legitimately differ from the
                 conversation's — which is shown on the usage bar instead. -->
            <span
              v-if="agentModel"
              :title="`This agent ran on ${agentModel}`"
            >Model: {{ agentModel }}</span>
            <span
              v-if="tokenSummary"
              :title="tokenTitle"
            >{{ tokenSummary }}</span>
          </div>
        </div>
      </div>

      <!-- Summary -->
      <div
        v-if="task.summary"
        class="bg-surface-50 dark:bg-surface-900 rounded-lg p-3"
      >
        <div class="text-xs font-medium text-surface-500 dark:text-surface-400 mb-1">
          Summary
        </div>
        <div class="text-sm text-surface-800 dark:text-surface-200 whitespace-pre-wrap">
          {{ task.summary }}
        </div>
      </div>

      <!-- Error -->
      <div
        v-if="task.error"
        class="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3"
      >
        <div class="text-xs font-medium text-red-500 mb-1">
          Error
        </div>
        <div class="text-sm text-red-800 dark:text-red-300 whitespace-pre-wrap font-mono">
          {{ task.error }}
        </div>
      </div>

      <!-- What the task is actually doing: the input to the tool call that
           spawned it. For a shell task this is the command; for an agent it is
           the prompt and sub-agent type. Rendered the same way the tool detail
           modal renders a tool's input, from the same helper. -->
      <div
        v-if="inputParams.length > 0"
        class="space-y-2"
      >
        <div class="text-xs font-medium text-surface-500 dark:text-surface-400 flex items-center gap-2">
          <Icon
            name="cpu"
            size="xs"
          />
          <span>Input</span>
          <span
            v-if="spawningTool"
            class="font-mono text-surface-400 dark:text-surface-500"
          >{{ spawningTool.toolName }}</span>
        </div>

        <div class="bg-surface-50 dark:bg-surface-900 rounded-lg p-3 space-y-2">
          <div
            v-for="param in inputParams"
            :key="param.key"
          >
            <div class="text-xs text-surface-500 dark:text-surface-400 mb-0.5">
              {{ param.label }}
            </div>
            <pre
              v-if="param.isBlock"
              class="text-xs text-surface-800 dark:text-surface-200 whitespace-pre-wrap font-mono max-h-60 overflow-y-auto"
            >{{ param.value }}</pre>
            <div
              v-else
              class="text-xs text-surface-800 dark:text-surface-200 font-mono break-all"
            >
              {{ param.value }}
            </div>
          </div>
        </div>
      </div>

      <!-- What the task has actually been doing.
           This is the substance of the modal while a task runs: the output
           file, summary, model and token fields are all empty until it
           finishes, so without this a live task showed an empty box. -->
      <div
        v-if="activity.length > 0"
        class="space-y-2"
      >
        <div class="text-xs font-medium text-surface-500 dark:text-surface-400 flex items-center gap-2">
          <Icon
            name="terminal"
            size="xs"
          />
          <span>Activity:</span>
          <span>{{ activity.length }} tool {{ activity.length === 1 ? 'call' : 'calls' }}</span>
        </div>

        <div class="bg-surface-50 dark:bg-surface-900 rounded-lg divide-y divide-surface-200 dark:divide-surface-700 max-h-80 overflow-y-auto">
          <button
            v-for="row in activity"
            :key="row.message.id"
            type="button"
            class="w-full text-left px-3 py-2 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
            :style="row.depth > 0 ? { paddingLeft: 0.75 + row.depth * 0.75 + 'rem' } : undefined"
            @click="openToolDetail(row.message.toolUse)"
          >
            <div class="flex items-baseline gap-2 min-w-0">
              <span class="font-mono text-xs font-medium text-primary-600 dark:text-primary-400 shrink-0">
                {{ row.message.toolUse?.toolName }}
              </span>
              <span class="text-xs text-surface-600 dark:text-surface-300 truncate">
                {{ row.message.toolUse?.description }}
              </span>
            </div>
          </button>
        </div>
      </div>

      <!-- A running task that has not called a tool yet. Said explicitly, so
           it does not read as a broken modal. -->
      <div
        v-else-if="task.status === 'running'"
        class="text-xs text-surface-500 dark:text-surface-400 italic"
      >
        No tool calls recorded for this task yet.
      </div>

      <!-- Output File Content -->
      <div
        v-if="task.outputFile"
        class="space-y-2"
      >
        <div class="text-xs font-medium text-surface-500 dark:text-surface-400 flex items-center gap-2">
          <Icon
            name="document"
            size="xs"
          />
          <span>Output:</span>
          <span class="font-mono truncate">{{ task.outputFile }}</span>
        </div>

        <div
          v-if="outputLoading"
          class="flex items-center gap-2 p-3 text-xs text-surface-500"
        >
          <Spinner size="xs" />
          Loading output file...
        </div>
        <div
          v-else-if="outputError"
          class="text-xs text-red-500 p-3 bg-red-50 dark:bg-red-900/20 rounded-lg"
        >
          Failed to load output: {{ outputError }}
        </div>
        <div
          v-else-if="outputContent !== null"
          class="bg-surface-50 dark:bg-surface-900 rounded-lg p-3 max-h-80 overflow-y-auto"
        >
          <pre class="text-xs text-surface-800 dark:text-surface-200 whitespace-pre-wrap font-mono">{{ outputContent }}</pre>
        </div>
      </div>

      <!-- No output yet. Said explicitly so a running task does not look like
           it has nothing to show, which is how this modal read before. -->
      <div
        v-else-if="task.status === 'running'"
        class="text-xs text-surface-500 dark:text-surface-400 italic"
      >
        Output will appear here once the task writes it.
      </div>

      <!-- Stopping a task. Only offered while it is actually running; the
           status here is live, so the button disappears once the task ends
           rather than offering to stop something already finished.
           Deliberately a sibling of the output block, not a child of it — it
           was nested inside `v-if="task.outputFile"`, so the button was
           invisible for exactly the common case of a running task that has
           not produced an output file. -->
      <div
        v-if="task.status === 'running'"
        class="pt-2 border-t border-surface-200 dark:border-surface-700"
      >
        <div
          v-if="stopError"
          class="text-xs text-red-500 mb-2 p-2 bg-red-50 dark:bg-red-900/20 rounded-lg"
        >
          {{ stopError }}
        </div>
        <Button
          variant="danger"
          size="sm"
          :disabled="stopping"
          @click="emit('stop', task.id)"
        >
          <Spinner
            v-if="stopping"
            size="xs"
            class="mr-1"
          />
          <Icon
            v-else
            name="close"
            size="xs"
            class="mr-1"
          />
          {{ stopping ? 'Stopping…' : 'Stop task' }}
        </Button>
      </div>
    </div>
  </Modal>
</template>
