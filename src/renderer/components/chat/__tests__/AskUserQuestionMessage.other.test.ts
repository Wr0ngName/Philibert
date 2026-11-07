/**
 * The free-text answer of a question card is a choice like the options:
 * it has the same mark, focusing its field chooses it, and in a
 * single-select question it and an option exclude each other — so the card
 * never shows an option chosen while the free text is what gets sent.
 */

import { mount } from '@vue/test-utils';
import { describe, it, expect, afterEach } from 'vitest';

import type { AskUserQuestionAction } from '@shared/types';

import AskUserQuestionMessage from '../AskUserQuestionMessage.vue';

function action(multiSelect: boolean): AskUserQuestionAction {
  return {
    id: 'act-q',
    type: 'ask-user-question',
    toolName: 'AskUserQuestion',
    description: 'Which approach?',
    status: 'pending',
    timestamp: 0,
    details: {
      questions: [{
        question: 'Which approach?',
        header: 'Approach',
        multiSelect,
        options: [
          { label: 'Rebase', description: 'Replay the commits' },
          { label: 'Merge', description: 'Keep the history' },
        ],
      }],
    },
  } as AskUserQuestionAction;
}

let wrapper: ReturnType<typeof mount> | null = null;

function mountCard(multiSelect: boolean) {
  wrapper = mount(AskUserQuestionMessage, {
    props: { action: action(multiSelect) },
    attachTo: document.body,
    global: { stubs: { Icon: true } },
  });
  return wrapper;
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

type Card = ReturnType<typeof mountCard>;

function chosen(card: Card): string[] {
  const options = card.findAll('.question-option')
    .filter((o) => o.attributes('aria-pressed') === 'true')
    .map((o) => o.find('.question-option-label').text());
  const other = card.find('.question-other-mark').attributes('aria-pressed') === 'true' ? ['Other'] : [];
  return [...options, ...other];
}

function option(card: Card, label: string) {
  return card.findAll('.question-option').find((o) => o.find('.question-option-label').text() === label)!;
}

async function send(card: Card): Promise<string | undefined> {
  await card.findAll('button').find((b) => b.text() === 'Send answer')!.trigger('click');
  const answers = card.emitted('answer')?.[0]?.[1] as Array<{ answer: string }> | undefined;
  return answers?.[0]?.answer;
}

describe('the free-text answer of a single-select question', () => {
  // Reported: an option picked before typing an answer of one's own stayed
  // shown as chosen, while the typed answer was the one sent.
  it('unchooses the picked option once its field is focused, and sends what was typed', async () => {
    const card = mountCard(false);
    await option(card, 'Rebase').trigger('click');
    expect(chosen(card)).toEqual(['Rebase']);

    const field = card.find('.question-other input');
    await field.trigger('focus');
    expect(chosen(card)).toEqual(['Other']);
    await field.setValue('Squash it');

    expect(await send(card)).toBe('Squash it');
  });

  it('is unchosen by picking an option again, which is then what is sent', async () => {
    const card = mountCard(false);
    const field = card.find('.question-other input');
    await field.trigger('focus');
    await field.setValue('Squash it');
    await option(card, 'Merge').trigger('click');

    expect(chosen(card)).toEqual(['Merge']);
    expect(await send(card)).toBe('Merge');
  });

  it('is chosen by its mark, which puts the cursor in its field', async () => {
    const card = mountCard(false);
    await option(card, 'Rebase').trigger('click');
    await card.find('.question-other-mark').trigger('click');

    expect(chosen(card)).toEqual(['Other']);
    expect(document.activeElement).toBe(card.find('.question-other input').element);
  });

  it('cannot be sent chosen but empty', async () => {
    const card = mountCard(false);
    await card.find('.question-other input').trigger('focus');

    expect(await send(card)).toBeUndefined();
  });
});

describe('the free-text answer of a multi-select question', () => {
  it('is checked along with the options, and added to them', async () => {
    const card = mountCard(true);
    await option(card, 'Rebase').trigger('click');
    const field = card.find('.question-other input');
    await field.trigger('focus');
    await field.setValue('Squash it');

    expect(chosen(card)).toEqual(['Rebase', 'Other']);
    expect(await send(card)).toBe('Rebase, Squash it');
  });

  it('is left out once its mark unchecks it', async () => {
    const card = mountCard(true);
    await option(card, 'Rebase').trigger('click');
    const field = card.find('.question-other input');
    await field.trigger('focus');
    await field.setValue('Squash it');
    await card.find('.question-other-mark').trigger('click');

    expect(chosen(card)).toEqual(['Rebase']);
    expect(await send(card)).toBe('Rebase');
  });

  it('is checked again by typing in its field, without its field being focused anew', async () => {
    const card = mountCard(true);
    const field = card.find('.question-other input');
    await field.trigger('focus');
    await card.find('.question-other-mark').trigger('click');
    expect(chosen(card)).toEqual([]);

    await field.setValue('Squash it');

    expect(chosen(card)).toEqual(['Other']);
    expect(await send(card)).toBe('Squash it');
  });
});
