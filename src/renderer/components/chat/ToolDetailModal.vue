<script setup lang="ts">
/**
 * Tool use detail modal — shows tool input parameters and lazy-loaded output.
 * Opened by clicking on a ToolUseMessage inline indicator.
 */

import { ref, watch, computed } from 'vue';

import type { ToolUseInfo } from '@shared/types';

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

const formattedInput = computed(() => {
  if (!props.toolUse?.input) return null;
  try {
    return JSON.stringify(props.toolUse.input, null, 2);
  } catch {
    return String(props.toolUse.input);
  }
});
</script>

<template>
  <Modal
    :open="open"
    title="Tool Details"
    size="lg"
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

      <!-- Input Parameters -->
      <div
        v-if="formattedInput"
        class="space-y-2"
      >
        <div class="text-xs font-medium text-surface-500 dark:text-surface-400 flex items-center gap-2">
          <Icon
            name="code"
            size="xs"
          />
          <span>Input</span>
        </div>
        <div class="bg-surface-50 dark:bg-surface-900 rounded-lg p-3 max-h-60 overflow-y-auto">
          <pre class="text-xs text-surface-800 dark:text-surface-200 whitespace-pre-wrap font-mono">{{ formattedInput }}</pre>
        </div>
      </div>

      <!-- Output Content -->
      <div
        v-if="toolUse.outputFile"
        class="space-y-2"
      >
        <div class="text-xs font-medium text-surface-500 dark:text-surface-400 flex items-center gap-2">
          <Icon
            name="document"
            size="xs"
          />
          <span>Output</span>
        </div>

        <div
          v-if="outputLoading"
          class="flex items-center gap-2 p-3 text-xs text-surface-500"
        >
          <Spinner size="xs" />
          Loading output...
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

      <!-- No output yet -->
      <div
        v-else-if="toolUse.status === 'pending' || toolUse.status === 'approved'"
        class="text-xs text-surface-400 dark:text-surface-500 italic"
      >
        Output will appear once the tool finishes executing.
      </div>
    </div>
  </Modal>
</template>
