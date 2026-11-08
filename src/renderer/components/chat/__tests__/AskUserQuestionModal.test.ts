/**
 * A question from Claude, in its own resizable dialog.
 *
 * The free-text answer is a choice like the options: it has the same mark,
 * focusing its field chooses it, and in a single-select question it and an
 * option exclude each other — so the dialog never shows an option chosen
 * while the free text is what gets sent.
 */

import { mount } from '@vue/test-utils';
import { describe, it, expect, afterEach } from 'vitest';
import { defineComponent } from 'vue';

import type { AskUserQuestionAction } from '@shared/types';

import AskUserQuestionModal from '../AskUserQuestionModal.vue';

/**
 * The shared dialog, rendered in place (the real one teleports to the body)
 * with its body, its footer and its close button, and the props it was
 * given kept for the test to read.
 */
const ModalStub = defineComponent({
  props: {
    open: Boolean,
    title: { type: String, default: '' },
    size: { type: String, default: 'md' },
    resizeKey: { type: String, default: undefined },
    closeOnOverlay: { type: Boolean, default: true },
    closeOnEscape: { type: Boolean, default: true },
  },
  emits: ['close'],
  template: `<div class="modal-stub">
    <button class="modal-close" @click="$emit('close')" />
    <slot /><footer><slot name="footer" /></footer>
  </div>`,
});

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
  wrapper = mount(AskUserQuestionModal, {
    props: { action: action(multiSelect) },
    attachTo: document.body,
    global: { stubs: { Icon: true, Modal: ModalStub } },
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

// Reported: the question, as a card above the composer, was hard to read.
describe('the question dialog', () => {
  it('is a resizable dialog that a click outside does not close', () => {
    const card = mountCard(false);
    const dialog = card.findComponent(ModalStub);

    expect(dialog.props('resizeKey')).toBe('ask-user-question');
    expect(dialog.props('closeOnOverlay')).toBe(false);
    expect(dialog.props('title')).toBe('Claude is asking a question');
  });

  it('cancels the question when it is closed', async () => {
    const card = mountCard(false);
    await card.find('.modal-close').trigger('click');

    expect(card.emitted('cancel')?.[0]).toEqual(['act-q']);
  });

  it('keeps Send and Cancel in its footer, out of the scrolling body', () => {
    const card = mountCard(false);
    const footer = card.find('.modal-stub > footer');

    expect(footer.findAll('button').map((b) => b.text())).toEqual(['Cancel', 'Send answer']);
  });

  it('sends with Ctrl+Enter wherever the focus is', async () => {
    const card = mountCard(false);
    await option(card, 'Merge').trigger('click');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));

    const answers = card.emitted('answer')?.[0]?.[1] as Array<{ answer: string }> | undefined;
    expect(answers?.[0]?.answer).toBe('Merge');
  });
});

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
