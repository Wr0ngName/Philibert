<script setup lang="ts">
/**
 * Read-only view of an AskUserQuestion call for the tool detail modal: each
 * question with its options, and — once answered — the chosen option(s)
 * highlighted, the answer as given and any notes the user added.
 */
import { computed } from 'vue';

import type { AskUserQuestionResultPayload } from '@shared/ask-user-question';
import type { AskUserQuestionEntry } from '@shared/types';

import Icon from '../shared/Icon.vue';

interface Props {
  questions: AskUserQuestionEntry[];
  /** The parsed tool result; null while unanswered or when it is not an answer payload */
  result: AskUserQuestionResultPayload | null;
}

const props = defineProps<Props>();

/** Multi-select answers are the chosen labels joined by ", " (see AskUserQuestionMessage). */
const MULTI_SELECT_SEPARATOR = ', ';

const items = computed(() =>
  props.questions.map((entry) => {
    const answer = props.result?.answers[entry.question];
    const chosen = new Set(
      answer === undefined
        ? []
        : entry.multiSelect ? answer.split(MULTI_SELECT_SEPARATOR) : [answer],
    );
    return {
      entry,
      answer,
      notes: props.result?.annotations?.[entry.question]?.notes,
      isChosen: (label: string) => chosen.has(label),
    };
  }),
);
</script>

<template>
  <div class="space-y-4">
    <div
      v-for="item in items"
      :key="item.entry.question"
      data-testid="question-detail"
      class="space-y-2"
    >
      <div class="flex flex-wrap items-center gap-2">
        <span
          v-if="item.entry.header"
          class="px-2 py-0.5 rounded-full text-[11px] font-medium bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300"
        >
          {{ item.entry.header }}
        </span>
        <span
          v-if="item.entry.multiSelect"
          class="text-[11px] text-surface-500 dark:text-surface-400"
        >
          Multiple choice
        </span>
      </div>
      <p class="text-sm font-medium text-surface-900 dark:text-surface-100">
        {{ item.entry.question }}
      </p>

      <ul class="space-y-1">
        <li
          v-for="option in item.entry.options"
          :key="option.label"
          data-testid="question-option"
          :data-chosen="item.isChosen(option.label)"
          :class="[
            'flex items-start gap-2 rounded-md px-2 py-1.5 text-xs',
            item.isChosen(option.label)
              ? 'bg-green-50 dark:bg-green-900/20 ring-1 ring-green-300 dark:ring-green-700'
              : 'bg-surface-50 dark:bg-surface-800/60',
          ]"
        >
          <Icon
            v-if="item.isChosen(option.label)"
            name="check-circle"
            size="xs"
            class="shrink-0 mt-0.5 text-green-500"
          />
          <span
            v-else
            class="shrink-0 mt-0.5 w-3 h-3 rounded-full border border-surface-300 dark:border-surface-600"
          />
          <div class="min-w-0">
            <div class="font-medium text-surface-800 dark:text-surface-200">
              {{ option.label }}
            </div>
            <div
              v-if="option.description"
              class="text-surface-500 dark:text-surface-400"
            >
              {{ option.description }}
            </div>
          </div>
        </li>
      </ul>

      <div
        v-if="item.answer !== undefined"
        data-testid="question-answer"
        class="text-xs text-surface-700 dark:text-surface-300"
      >
        <span class="font-medium text-surface-500 dark:text-surface-400">Answer:</span>
        {{ item.answer }}
      </div>
      <div
        v-if="item.notes"
        data-testid="question-notes"
        class="text-xs text-surface-700 dark:text-surface-300 whitespace-pre-wrap"
      >
        <span class="font-medium text-surface-500 dark:text-surface-400">Notes:</span>
        {{ item.notes }}
      </div>
    </div>
  </div>
</template>
