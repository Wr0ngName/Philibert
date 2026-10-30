/**
 * The tool detail modal shows a call's input and output in readable form:
 * object/array inputs keep their formatting, JSON output is pretty-printed,
 * and an AskUserQuestion reads as questions and answers rather than JSON.
 *
 * PROBE_* are the input and tool_result the bundled CLI produced for an
 * answered AskUserQuestion (scratch probe, SDK 0.3.280).
 */

import { flushPromises, mount } from '@vue/test-utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ToolUseInfo } from '@shared/types';

import ToolDetailModal from '../ToolDetailModal.vue';

const PROBE_INPUT = {
  questions: [{
    question: 'Which color do you prefer?',
    header: 'Color preference',
    options: [
      { label: 'Red', description: 'The color red' },
      { label: 'Blue', description: 'The color blue' },
    ],
    multiSelect: false,
  }],
};
const PROBE_RESULT =
  '{"questions":[{"question":"Which color do you prefer?","header":"Color preference","options":[{"label":"Red","description":"The color red"},{"label":"Blue","description":"The color blue"}],"multiSelect":false}],"answers":{"Which color do you prefer?":"Blue"}}';

let readFile: ReturnType<typeof vi.fn>;

function toolUse(overrides: Partial<ToolUseInfo>): ToolUseInfo {
  return {
    actionId: 'act-1',
    toolName: 'AskUserQuestion',
    description: 'Ask a question',
    status: 'executed',
    input: PROBE_INPUT,
    outputFile: '/tmp/claude/tool-results/out.txt',
    ...overrides,
  };
}

async function mountModal(info: ToolUseInfo, calledAt?: number) {
  const wrapper = mount(ToolDetailModal, {
    props: { open: true, toolUse: info, calledAt },
    global: {
      stubs: {
        Modal: { template: '<div><slot /></div>' },
        Spinner: true,
        Icon: true,
      },
    },
  });
  await flushPromises();
  return wrapper;
}

describe('ToolDetailModal duration', () => {
  const CALLED = 1_700_000_000_000;

  it("shows how long a finished call took, as an agent's view does", async () => {
    const wrapper = await mountModal(
      toolUse({ toolName: 'Bash', input: { command: 'npm test' }, completedAt: CALLED + 72_000 }),
      CALLED,
    );

    expect(wrapper.text()).toContain('Duration: 1m 12s');
  });

  it('counts up while the call runs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(CALLED + 5_000);
    try {
      const wrapper = await mountModal(
        toolUse({ toolName: 'Bash', input: { command: 'npm test' }, status: 'approved', outputFile: undefined }),
        CALLED,
      );
      expect(wrapper.text()).toContain('Duration: 5s');

      await vi.advanceTimersByTimeAsync(3_000);
      expect(wrapper.text()).toContain('Duration: 8s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows none for a call that never ran, or one saved without its end', async () => {
    const rejected = await mountModal(toolUse({ status: 'rejected' }), CALLED);
    const unrecorded = await mountModal(toolUse({ status: 'executed' }), CALLED);

    expect(rejected.text()).not.toContain('Duration');
    expect(unrecorded.text()).not.toContain('Duration');
  });
});

describe('ToolDetailModal', () => {
  beforeEach(() => {
    readFile = vi.fn().mockResolvedValue(PROBE_RESULT);
    (globalThis as unknown as { window: Record<string, unknown> }).window.electron = {
      files: { read: readFile },
    } as never;
  });

  describe('AskUserQuestion', () => {
    it('shows the question and its options instead of JSON', async () => {
      const wrapper = await mountModal(toolUse({}));

      const question = wrapper.find('[data-testid="question-detail"]');
      expect(question.text()).toContain('Color preference');
      expect(question.text()).toContain('Which color do you prefer?');
      expect(question.findAll('[data-testid="question-option"]').map(o => o.text())).toEqual([
        'RedThe color red',
        'BlueThe color blue',
      ]);
      expect(wrapper.text()).not.toContain('"questions"');
      expect(wrapper.text()).not.toContain('"answers"');
    });

    it('marks the chosen option and states the answer, without a raw output block', async () => {
      const wrapper = await mountModal(toolUse({}));

      const chosen = wrapper.findAll('[data-testid="question-option"]').map(o => o.attributes('data-chosen'));
      expect(chosen).toEqual(['false', 'true']);
      expect(wrapper.find('[data-testid="question-answer"]').text()).toBe('Answer: Blue');
      expect(wrapper.find('pre').exists()).toBe(false);
    });

    it('marks every option of a multi-select answer', async () => {
      const input = { questions: [{ ...PROBE_INPUT.questions[0], multiSelect: true }] };
      readFile.mockResolvedValue(JSON.stringify({
        questions: input.questions,
        answers: { 'Which color do you prefer?': 'Red, Blue' },
        annotations: { 'Which color do you prefer?': { notes: 'both are fine' } },
      }));

      const wrapper = await mountModal(toolUse({ input }));

      const chosen = wrapper.findAll('[data-testid="question-option"]').map(o => o.attributes('data-chosen'));
      expect(chosen).toEqual(['true', 'true']);
      expect(wrapper.find('[data-testid="question-notes"]').text()).toBe('Notes: both are fine');
    });

    it('shows a cancellation as the text it is', async () => {
      readFile.mockResolvedValue('User cancelled the question.');

      const wrapper = await mountModal(toolUse({ status: 'rejected' }));

      expect(wrapper.findAll('[data-testid="question-option"]').map(o => o.attributes('data-chosen')))
        .toEqual(['false', 'false']);
      expect(wrapper.find('pre').text()).toBe('User cancelled the question.');
    });
  });

  describe('other tools', () => {
    it('pretty-prints JSON output', async () => {
      readFile.mockResolvedValue('{"items":[1,2]}');

      const wrapper = await mountModal(toolUse({ toolName: 'mcp__docs__search', input: { query: 'x' } }));

      expect(wrapper.find('pre').text()).toBe('{\n  "items": [\n    1,\n    2\n  ]\n}');
    });

    it('renders an object input as a preformatted block', async () => {
      readFile.mockResolvedValue('ok');

      const wrapper = await mountModal(toolUse({ toolName: 'TodoWrite', input: { todos: [{ content: 'a' }] } }));

      const blocks = wrapper.findAll('pre').map(p => p.text());
      expect(blocks[0]).toBe('[\n  {\n    "content": "a"\n  }\n]');
    });
  });
});
