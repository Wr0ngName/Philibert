<script setup lang="ts">
/**
 * Tool use detail modal — shows tool input parameters and lazy-loaded output.
 * Opened by clicking on a ToolUseMessage inline indicator.
 *
 * Input and output are the ones the background task view uses for a command
 * (ToolCallView).
 */

import { ref, watch, computed } from 'vue';

import {
  ASK_USER_QUESTION_TOOL,
  parseAskUserQuestionEntries,
  parseAskUserQuestionResult,
} from '@shared/ask-user-question';
import type { ToolUseInfo } from '@shared/types';

import type { ToolCallOutput } from '../../utils/tool-output';
import AskUserQuestionDetails from './AskUserQuestionDetails.vue';
import ToolCallView from './ToolCallView.vue';
import Icon from '../shared/Icon.vue';
import Modal from '../shared/Modal.vue';
import Spinner from '../shared/Spinner.vue';

interface Props {
  open: boolean;
  toolUse: ToolUseInfo | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const outputContent = ref<string | null>(null);
const outputLoading = ref(false);
const outputError = ref<string | null>(null);

watch(
  () => ({ open: props.open, outputFile: props.toolUse?.outputFile }),
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

const statusDisplay = computed(() => {
  if (!props.toolUse) return { label: '', colorClass: '' };
  switch (props.toolUse.status) {
    case 'pending':
      return { label: 'Pending', colorClass: 'text-yellow-500' };
    case 'approved':
      return { label: 'Running', colorClass: 'text-blue-500' };
    case 'executed':
      return { label: 'Completed', colorClass: 'text-green-500' };
    case 'rejected':
      return { label: 'Rejected', colorClass: 'text-red-500' };
    case 'failed':
      return { label: 'Failed', colorClass: 'text-red-500' };
    default:
      return { label: '', colorClass: '' };
  }
});

/** An AskUserQuestion call's questions; empty for any other tool. */
const questions = computed(() =>
  props.toolUse?.toolName === ASK_USER_QUESTION_TOOL ? parseAskUserQuestionEntries(props.toolUse.input) : [],
);

/** The answers, once the output is loaded and is an answer payload. */
const questionResult = computed(() =>
  questions.value.length > 0 && outputContent.value !== null
    ? parseAskUserQuestionResult(outputContent.value)
    : null,
);

/**
 * The Output section: the file once read, or why there is none yet. An
 * answered question already shows its answers above, so it has none.
 */
const output = computed((): ToolCallOutput | null => {
  const toolUse = props.toolUse;
  if (!toolUse) return null;
  if (toolUse.outputFile && !questionResult.value) {
    if (outputLoading.value) return { kind: 'loading' };
    if (outputError.value) return { kind: 'error', message: outputError.value };
    if (outputContent.value !== null) return { kind: 'text', text: outputContent.value };
    return null;
  }
  if (!toolUse.outputFile && (toolUse.status === 'pending' || toolUse.status === 'approved')) {
    return { kind: 'note', message: 'Output will appear once the tool finishes executing.' };
  }
  return null;
});
</script>

<template>
  <Modal
    :open="open"
    title="Tool Details"
    size="3xl"
    @close="emit('close')"
  >
    <div
      v-if="toolUse"
      class="space-y-4"
    >
      <!-- Status & Description -->
      <div class="flex items-start gap-3">
        <div :class="['shrink-0 mt-0.5', statusDisplay.colorClass]">
          <Spinner
            v-if="toolUse.status === 'pending' || toolUse.status === 'approved'"
            size="sm"
          />
          <Icon
            v-else-if="toolUse.status === 'executed'"
            name="check-circle"
            size="md"
          />
          <Icon
            v-else
            name="x-circle"
            size="md"
          />
        </div>
        <div class="flex-1 min-w-0">
          <h3 class="text-sm font-semibold text-surface-900 dark:text-surface-100">
            {{ toolUse.toolName }}
          </h3>
          <p class="text-xs text-surface-500 dark:text-surface-400 mt-0.5">
            {{ toolUse.description }}
          </p>
          <div class="flex items-center gap-3 mt-1 text-xs text-surface-500 dark:text-surface-400">
            <span :class="statusDisplay.colorClass">{{ statusDisplay.label }}</span>
          </div>
        </div>
      </div>

      <!-- AskUserQuestion: questions, options and the answers given, in place
           of the raw input. -->
      <div
        v-if="questions.length > 0"
        class="space-y-3"
      >
        <div class="text-xs font-medium text-surface-500 dark:text-surface-400 flex items-center gap-2">
          <Icon
            name="chat"
            size="xs"
          />
          <span>{{ questions.length === 1 ? 'Question' : 'Questions' }}</span>
        </div>
        <AskUserQuestionDetails
          :questions="questions"
          :result="questionResult"
        />
      </div>

      <ToolCallView
        :input="questions.length > 0 ? undefined : toolUse.input"
        :output="output"
      />
    </div>
  </Modal>
</template>
