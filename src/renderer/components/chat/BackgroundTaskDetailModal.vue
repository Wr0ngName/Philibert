<script setup lang="ts">
/**
 * Background task detail modal (equivalent of Ctrl+O in Claude Code CLI).
 *
 * An agent is shown the way the discussion is — its prompt, what it said, the
 * calls it made and their results — by the same message list, read from its
 * transcript and followed while it runs. A command is shown as its command
 * line and its output, followed the same way.
 */

import { computed } from 'vue';

import type { BackgroundTask, ToolUseInfo } from '@shared/types';

import { useNowTicker } from '../../composables/useNowTicker';
import { useAgentTranscript, useCommandOutput } from '../../composables/useTaskDetailFeed';
import { useConversationsStore } from '../../stores/conversations';
import { formatModelId } from '../../utils/model';
import { formatTaskDuration } from '../../utils/task-duration';
import { formatTokenCount } from '../../utils/token-count';
import type { ToolCallOutput } from '../../utils/tool-output';
import Button from '../shared/Button.vue';
import Icon from '../shared/Icon.vue';
import Modal from '../shared/Modal.vue';
import Spinner from '../shared/Spinner.vue';
import { heldListSource } from './message-list-source';
import MessageList from './MessageList.vue';
import ToolCallView from './ToolCallView.vue';

interface Props {
  open: boolean;
  task: BackgroundTask | null;
  /** The conversation the task belongs to. */
  conversationId: string;
  /** The agent that started this task, when an agent did. */
  parentTask?: BackgroundTask | null;
  /**
   * The tool call that spawned this task, when there is one. For a command
   * its input is the command line; an agent's prompt is the first message of
   * its transcript instead.
   */
  spawningTool?: ToolUseInfo | null;
  /** Whether a stop request is in flight. */
  stopping?: boolean;
  /** Why the last stop attempt failed, if it did. */
  stopError?: string | null;
}

const props = withDefaults(defineProps<Props>(), {
  parentTask: null,
  spawningTool: null,
  stopping: false,
  stopError: null,
});

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'stop', taskId: string): void;
  /** Show one of the task's tool calls in the tool detail modal. */
  (e: 'open-tool-detail', toolUse: ToolUseInfo): void;
  /** Show another task — the agent that started this one, or one it started. */
  (e: 'open-task-detail', taskId: string): void;
}>();

const conversationsStore = useConversationsStore();

const isAgent = computed(() => props.task?.taskType === 'agent');
const isRunning = computed(() => props.task?.status === 'running');

const feed = {
  open: () => props.open,
  task: () => props.task,
  conversationId: () => props.conversationId,
};
const transcript = useAgentTranscript(feed);
const output = useCommandOutput(feed);

/** The agent's transcript, for the same list the discussion uses. */
const transcriptSource = heldListSource(() => ({
  key: `agent:${props.task?.id ?? ''}`,
  conversationId: props.conversationId,
  messages: transcript.messages.value,
  isLoading: isRunning.value,
  workingDirectory: conversationsStore.getConversationWorkingDirectory(props.conversationId) ?? '',
}));

/** Who the transcript's assistant turns are from. */
const agentLabel = computed(() => props.task?.agentType ?? 'Agent');

/** A call in the transcript, opened in the tool detail modal. */
function openTranscriptTool(toolUseBlockId: string): void {
  const toolUse = transcript.messages.value.find((m) => m.toolUse?.toolUseBlockId === toolUseBlockId)?.toolUse;
  if (toolUse) emit('open-tool-detail', toolUse);
}

/**
 * The command's tool call: the one in the discussion when the main
 * conversation made it, otherwise the one the task carries — a command an
 * agent started is a call in the agent's transcript.
 */
const commandToolName = computed(() => props.spawningTool?.toolName ?? props.task?.toolName);

/** The command's input: its command line, as Tool Details shows a call's input. */
const commandInput = computed(() => props.spawningTool?.input ?? props.task?.toolInput);

/**
 * The command's Output section: what it has written so far, or what an empty
 * output means, as far as it is known — a command that has printed nothing
 * yet (some write to a log file of their own instead), or no output file to
 * read at all.
 */
const commandOutput = computed((): ToolCallOutput => {
  if (!output.loaded.value) return { kind: 'loading' };
  if (output.text.value) return { kind: 'text', text: output.text.value, skippedBytes: output.skippedBytes.value };
  if (!output.found.value) {
    return {
      kind: 'note',
      message: isRunning.value
        ? 'No output file yet: the command has not written to the console.'
        : 'Its output is no longer available.',
    };
  }
  return {
    kind: 'note',
    message: isRunning.value
      ? 'Nothing printed yet. The command may be writing to a log file of its own instead of the console.'
      : 'This command wrote no output.',
  };
});

/**
 * Ticks only while this modal is open on a task that is still running. A
 * finished task's duration comes from its own `completedAt` and does not
 * move.
 */
const now = useNowTicker(() => props.open && isRunning.value);

/**
 * Null when it is not known: an ended task with no completion time — one
 * recorded before rows stored it — would otherwise be measured up to now and
 * read as having run for days.
 */
const duration = computed(() => {
  if (!props.task) return null;
  if (!isRunning.value && props.task.completedAt === undefined) return null;
  return formatTaskDuration(props.task, now.value);
});

/**
 * Why a task whose command had a timeout is still going long past it.
 *
 * A foreground Bash command that reaches its `timeout` is not killed: the CLI
 * moves it to the background. So the timeout in the Input below is what put
 * this task here, not a limit it is still under — and once backgrounded a
 * command runs until it finishes or is stopped. Without saying so, the panel
 * reads as a five-minute timeout being ignored for three hours.
 */
const autoBackgrounded = computed(() => {
  const ms = props.task?.timedOutAfterMs;
  if (typeof ms !== 'number' || ms <= 0) return null;
  const seconds = Math.round(ms / 1000);
  const spell = seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`;
  return `Moved to the background after reaching its ${spell} timeout — background tasks run until they finish or are stopped.`;
});

/** The model this agent ran on, when the SDK attributed one to it. */
const agentModel = computed(() =>
  props.task?.model ? formatModelId(props.task.model) : null,
);

/**
 * Tokens this agent has used. The CLI's own count when it gave one — the
 * number its row shows — and otherwise what was added up from the agent's
 * frames.
 */
const tokenSummary = computed(() => {
  const task = props.task;
  if (!task) return null;
  const total = task.totalTokens ?? (task.inputTokens ?? 0) + (task.outputTokens ?? 0);
  return total > 0 ? `${formatTokenCount(total)} tokens` : null;
});

const tokenTitle = computed(() => {
  const input = props.task?.inputTokens ?? 0;
  const output_ = props.task?.outputTokens ?? 0;
  if (input === 0 && output_ === 0) return undefined;
  return `${input.toLocaleString()} in (including cache reads) / ${output_.toLocaleString()} out`;
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
            v-if="isRunning"
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
            <span
              v-if="isAgent && task.agentType"
              class="font-mono text-purple-600 dark:text-purple-400 mr-1"
            >{{ task.agentType }}</span>
            {{ task.description }}
          </h3>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-surface-500 dark:text-surface-400">
            <span :class="statusDisplay.colorClass">{{ statusDisplay.label }}</span>
            <span v-if="duration">Duration: {{ duration }}</span>
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
            <span v-if="task.toolUses !== undefined">{{ task.toolUses }} tool {{ task.toolUses === 1 ? 'use' : 'uses' }}</span>
            <!-- Where this task came from, when an agent rather than the main
                 conversation started it. -->
            <button
              v-if="parentTask"
              type="button"
              class="inline-flex items-center gap-1 text-purple-600 dark:text-purple-400 hover:underline"
              :title="parentTask.description"
              @click="emit('open-task-detail', parentTask.id)"
            >
              <Icon
                name="cpu"
                size="xs"
              />
              Started by {{ parentTask.agentType ?? 'an agent' }}
            </button>
          </div>
          <p
            v-if="isRunning && task.activity"
            class="mt-1 text-xs text-surface-600 dark:text-surface-300 truncate"
          >
            {{ task.activity }}
          </p>
          <!-- The timeout in the Input below is what backgrounded this task,
               not a limit it is still under. Said here because otherwise a
               five-minute timeout next to a three-hour duration reads as a
               bug. -->
          <p
            v-if="autoBackgrounded"
            class="mt-1 text-xs text-amber-600 dark:text-amber-500"
          >
            {{ autoBackgrounded }}
          </p>
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
        <div class="text-sm text-surface-800 dark:text-surface-200 whitespace-pre-wrap max-h-40 overflow-y-auto">
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

      <!-- An agent: its transcript, drawn by the discussion's own list. -->
      <div
        v-if="isAgent"
        class="agent-transcript"
      >
        <div
          v-if="!transcript.loaded.value"
          class="flex items-center gap-2 p-3 text-xs text-surface-500"
        >
          <Spinner size="xs" />
          Loading the agent's transcript…
        </div>
        <MessageList
          v-else
          :source="transcriptSource"
          user-label="Claude"
          :assistant-label="agentLabel"
          empty-title="Nothing yet"
          empty-text="The agent's prompt, messages and tool calls appear here as it works."
          @open-tool-detail="openTranscriptTool"
          @open-task-detail="emit('open-task-detail', $event)"
        />
      </div>

      <!-- A command: its command line and its output, followed while it
           runs — the same view Tool Details gives a call in the discussion. -->
      <ToolCallView
        v-else
        :input="commandInput"
        :tool-name="commandToolName"
        :output="commandOutput"
        :live="isRunning"
      />


      <!-- Stopping a task. Only offered while it is actually running; the
           status here is live, so the button disappears once the task ends
           rather than offering to stop something already finished. -->
      <div
        v-if="isRunning"
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

<style scoped>
/* The message list fills its parent, so it is given the height to fill. */
.agent-transcript {
  display: flex;
  flex-direction: column;
  height: 60vh;
}
</style>
