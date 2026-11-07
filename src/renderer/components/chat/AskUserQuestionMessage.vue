<script setup lang="ts">
/**
 * AskUserQuestion message — surfaces a multiple-choice question from Claude
 * and captures the user's answer(s).
 *
 * Shape mirrors the SDK's AskUserQuestion tool: 1-4 questions per call, each
 * with a header chip, 2-4 options, optional preview, optional multi-select,
 * plus a free-text "Other" fallback. When channel mode delivers a truncated
 * payload, falls back to a single free-text input with the truncated description.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';

import type {
  AskUserQuestionAction,
  AskUserQuestionAnswer,
  AskUserQuestionEntry,
} from '@shared/types';

import Button from '../shared/Button.vue';
import Icon from '../shared/Icon.vue';

interface Props {
  action: AskUserQuestionAction;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'answer', actionId: string, answers: AskUserQuestionAnswer[]): void;
  (e: 'cancel', actionId: string): void;
}>();

const cardRef = ref<HTMLElement | null>(null);

const truncated = computed(() => props.action.details.truncated);
const questions = computed<AskUserQuestionEntry[]>(() => props.action.details.questions);
const fallbackDescription = computed(() => props.action.details.fallbackDescription || props.action.description);

/**
 * Per-question state.
 *
 * The free-text answer is a choice like the options: `otherSelected` says
 * whether it is chosen, `otherText` holds what was typed.
 * For non-multiSelect: one choice at most — an option in `selectedLabels`,
 *   or the free text.
 * For multiSelect: `selectedLabels` accumulates choices, and the free text,
 *   when chosen, is added to them.
 */
interface QuestionState {
  selectedLabels: Set<string>;
  otherSelected: boolean;
  otherText: string;
  notes: string;
}

const states = ref<QuestionState[]>([]);

function initStates(): void {
  states.value = questions.value.map(() => ({
    selectedLabels: new Set<string>(),
    otherSelected: false,
    otherText: '',
    notes: '',
  }));
}

initStates();

/** Truncated fallback state */
const truncatedAnswer = ref('');

function toggleOption(qIndex: number, label: string): void {
  const state = states.value[qIndex];
  const question = questions.value[qIndex];
  if (question.multiSelect) {
    if (state.selectedLabels.has(label)) {
      state.selectedLabels.delete(label);
    } else {
      state.selectedLabels.add(label);
    }
  } else {
    state.selectedLabels.clear();
    state.selectedLabels.add(label);
    state.otherSelected = false;
  }
}

/** Choose the free-text answer: what typing in it, or focusing it, does. */
function selectOther(qIndex: number): void {
  const state = states.value[qIndex];
  if (!questions.value[qIndex].multiSelect) state.selectedLabels.clear();
  state.otherSelected = true;
}

const otherInputs = ref<Record<number, HTMLInputElement | null>>({});

/**
 * A click on the free-text row's mark: in a multi-select question, it
 * unchecks the free text when checked; otherwise it chooses it and puts the
 * cursor in its field.
 */
function toggleOther(qIndex: number): void {
  const state = states.value[qIndex];
  if (questions.value[qIndex].multiSelect && state.otherSelected) {
    state.otherSelected = false;
    return;
  }
  selectOther(qIndex);
  otherInputs.value[qIndex]?.focus();
}

/** The free text, when it is chosen and says something. */
function chosenOtherText(state: QuestionState): string {
  return state.otherSelected ? state.otherText.trim() : '';
}

function isSelected(qIndex: number, label: string): boolean {
  return states.value[qIndex].selectedLabels.has(label);
}

/** A choice's row, chosen or not: the options and the free text alike. */
function choiceClass(selected: boolean): string[] {
  return [
    'text-left rounded-md border px-3 py-2 transition-colors',
    selected
      ? 'bg-blue-100 dark:bg-blue-900/30 border-blue-500'
      : 'bg-surface-50 dark:bg-surface-800 border-surface-300 dark:border-surface-600 hover:bg-surface-100 dark:hover:bg-surface-700',
  ];
}

/** A choice's mark: a check box in a multi-select question, else a radio. */
function markClass(multiSelect: boolean | undefined, selected: boolean): string[] {
  const shape = multiSelect ? 'rounded' : 'rounded-full';
  const look = selected
    ? multiSelect ? 'bg-blue-500 border-blue-500' : 'bg-blue-500 border-blue-500 ring-2 ring-blue-200 dark:ring-blue-800'
    : 'border-surface-400 dark:border-surface-500';
  return ['inline-block w-3.5 h-3.5 shrink-0 border', shape, look];
}

/** Preview of the currently focused option in a single-select question */
const focusedOption = ref<Record<number, string | null>>({});

function focusOption(qIndex: number, label: string): void {
  focusedOption.value[qIndex] = label;
}

function focusedOptionPreview(qIndex: number): string | undefined {
  const label = focusedOption.value[qIndex];
  if (!label) {
    // Default: preview of first selected, or first with preview
    const state = states.value[qIndex];
    const firstSelected = [...state.selectedLabels][0];
    if (firstSelected) {
      const opt = questions.value[qIndex].options.find((o) => o.label === firstSelected);
      if (opt?.preview) return opt.preview;
    }
    return undefined;
  }
  const opt = questions.value[qIndex].options.find((o) => o.label === label);
  return opt?.preview;
}

function anyOptionHasPreview(qIndex: number): boolean {
  return questions.value[qIndex].options.some((o) => !!o.preview);
}

/** Whether all questions have a usable answer (selected option, free text, or notes) */
const canSubmit = computed(() => {
  if (truncated.value) {
    return truncatedAnswer.value.trim().length > 0;
  }
  // An option, or a chosen free text that says something.
  return states.value.every((state) => state.selectedLabels.size > 0 || chosenOtherText(state) !== '');
});

function submit(): void {
  if (!canSubmit.value) return;

  if (truncated.value) {
    emit('answer', props.action.id, [{
      question: fallbackDescription.value,
      answer: truncatedAnswer.value.trim(),
    }]);
    return;
  }

  const answers: AskUserQuestionAnswer[] = questions.value.map((q, i) => {
    const state = states.value[i];
    const labels = [...state.selectedLabels];
    const other = chosenOtherText(state);
    let answer: string;

    if (q.multiSelect) {
      const parts = [...labels];
      if (other) parts.push(other);
      answer = parts.join(', ');
    } else {
      answer = other || labels[0] || '';
    }

    // Capture preview annotation if the selected option (non-multiSelect) had one
    let preview: string | undefined;
    if (!q.multiSelect && labels.length === 1) {
      const opt = q.options.find((o) => o.label === labels[0]);
      preview = opt?.preview;
    }

    const result: AskUserQuestionAnswer = {
      question: q.question,
      answer,
    };
    if (preview) result.preview = preview;
    if (state.notes.trim()) result.notes = state.notes.trim();
    return result;
  });

  emit('answer', props.action.id, answers);
}

function cancel(): void {
  emit('cancel', props.action.id);
}

/** Submit on Enter (when focus is inside the card and not in a textarea); Escape cancels. */
function handleKeydown(event: KeyboardEvent): void {
  if (!cardRef.value?.contains(event.target as Node)) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    cancel();
    return;
  }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canSubmit.value) {
    event.preventDefault();
    submit();
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown);
  cardRef.value?.focus();
});
onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <div
    ref="cardRef"
    class="action-card animate-slide-up outline-hidden focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 dark:focus:ring-offset-surface-800"
    role="dialog"
    :aria-labelledby="`question-title-${action.id}`"
    tabindex="0"
  >
    <!-- Header -->
    <div class="flex items-start gap-3 mb-3">
      <div
        class="shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-blue-100 dark:bg-blue-900/30 text-blue-500"
        aria-hidden="true"
      >
        <Icon
          name="info"
          size="sm"
          aria-hidden="true"
        />
      </div>
      <div class="flex-1">
        <h4
          :id="`question-title-${action.id}`"
          class="font-medium text-surface-900 dark:text-surface-100"
        >
          Claude is asking a question
        </h4>
        <p class="text-xs text-surface-500 dark:text-surface-400 mt-0.5">
          Esc=cancel, Ctrl/Cmd+Enter=submit
        </p>
      </div>
    </div>

    <!-- Truncated fallback (channel mode with clipped payload) -->
    <div
      v-if="truncated"
      class="space-y-3"
    >
      <div class="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3">
        <p class="text-sm text-amber-900 dark:text-amber-100">
          The question was too long for the channel preview. Showing the
          truncated form — please type your answer below.
        </p>
      </div>
      <p class="text-sm text-surface-700 dark:text-surface-200 whitespace-pre-wrap">
        {{ fallbackDescription }}
      </p>
      <textarea
        v-model="truncatedAnswer"
        class="w-full rounded-md border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-900 p-2 text-sm"
        rows="3"
        placeholder="Type your answer here…"
      />
    </div>

    <!-- Structured questions -->
    <div
      v-else
      class="space-y-5"
    >
      <div
        v-for="(question, qIndex) in questions"
        :key="qIndex"
        class="space-y-2"
      >
        <div class="flex items-center gap-2">
          <span
            v-if="question.header"
            class="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-200"
          >
            {{ question.header }}
          </span>
          <span
            v-if="question.multiSelect"
            class="text-[10px] text-surface-500 dark:text-surface-400"
          >
            (multi-select)
          </span>
        </div>

        <p class="text-sm text-surface-800 dark:text-surface-100 whitespace-pre-wrap">
          {{ question.question }}
        </p>

        <div
          :class="[
            'gap-3',
            anyOptionHasPreview(qIndex) ? 'grid grid-cols-1 md:grid-cols-2' : 'flex flex-col',
          ]"
        >
          <!-- Options list -->
          <div class="flex flex-col gap-1.5">
            <button
              v-for="option in question.options"
              :key="option.label"
              type="button"
              class="question-option focus:outline-none focus:ring-2 focus:ring-primary-500"
              :class="choiceClass(isSelected(qIndex, option.label))"
              :aria-pressed="isSelected(qIndex, option.label)"
              @click="toggleOption(qIndex, option.label)"
              @mouseenter="focusOption(qIndex, option.label)"
              @focus="focusOption(qIndex, option.label)"
            >
              <div class="flex items-start gap-2">
                <span
                  class="mt-0.5"
                  :class="markClass(question.multiSelect, isSelected(qIndex, option.label))"
                  aria-hidden="true"
                />
                <div class="flex-1">
                  <div class="question-option-label text-sm font-medium text-surface-900 dark:text-surface-100">
                    {{ option.label }}
                  </div>
                  <div
                    v-if="option.description"
                    class="text-xs text-surface-600 dark:text-surface-300 mt-0.5"
                  >
                    {{ option.description }}
                  </div>
                </div>
              </div>
            </button>
            <!-- The free-text answer: a choice like the others. Focusing
                 its field chooses it; choosing another option in a
                 single-select question unchooses it. -->
            <div
              class="question-other flex items-center gap-2"
              :class="choiceClass(states[qIndex].otherSelected)"
            >
              <button
                type="button"
                class="question-other-mark flex focus:outline-none focus:ring-2 focus:ring-primary-500 rounded"
                :aria-pressed="states[qIndex].otherSelected"
                :aria-label="question.multiSelect ? 'Add your own answer' : 'Answer with your own words'"
                @click="toggleOther(qIndex)"
              >
                <span
                  :class="markClass(question.multiSelect, states[qIndex].otherSelected)"
                  aria-hidden="true"
                />
              </button>
              <input
                :ref="(el) => { otherInputs[qIndex] = el as HTMLInputElement | null }"
                v-model="states[qIndex].otherText"
                type="text"
                :placeholder="question.multiSelect ? 'Other (added to selection)…' : 'Other…'"
                class="flex-1 min-w-0 rounded border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-900 px-2 py-1 text-sm"
                @focus="selectOther(qIndex)"
                @input="selectOther(qIndex)"
              >
            </div>
          </div>

          <!-- Preview pane (only when options carry preview content) -->
          <div
            v-if="anyOptionHasPreview(qIndex)"
            class="rounded-md border border-surface-300 dark:border-surface-600 bg-surface-100 dark:bg-surface-900 p-3 overflow-auto max-h-72"
          >
            <pre
              v-if="focusedOptionPreview(qIndex)"
              class="text-xs font-mono whitespace-pre-wrap text-surface-800 dark:text-surface-200"
            >{{ focusedOptionPreview(qIndex) }}</pre>
            <p
              v-else
              class="text-xs italic text-surface-500 dark:text-surface-400"
            >
              Hover an option to preview.
            </p>
          </div>
        </div>

        <!-- Optional notes -->
        <input
          v-model="states[qIndex].notes"
          type="text"
          placeholder="Notes (optional)…"
          class="w-full rounded-md border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 p-1.5 text-xs"
        >
      </div>
    </div>

    <!-- Footer actions -->
    <div class="flex justify-end gap-2 mt-4">
      <Button
        variant="secondary"
        size="sm"
        @click="cancel"
      >
        Cancel
      </Button>
      <Button
        variant="primary"
        size="sm"
        :disabled="!canSubmit"
        @click="submit"
      >
        Send answer
      </Button>
    </div>
  </div>
</template>
