/**
 * Tests for parseQuestionsFromPreview.
 *
 * The channel-server receives AskUserQuestion `input_preview` strings that are
 * Claude Code's `JSON.stringify(input).slice(0, 200) + '…'` (when over 200 chars).
 * This parser must:
 *  - extract structured questions when the JSON is complete
 *  - report truncated=true when the JSON is clipped (suffix '…' or '...')
 *  - degrade safely to an empty array with truncated=true when JSON is unparseable
 *  - skip malformed entries (missing question/options/labels) silently
 */

import { describe, it, expect } from 'vitest';

import { parseQuestionsFromPreview } from '../question-preview-parser';

describe('parseQuestionsFromPreview', () => {
  it('returns truncated=true for empty input', () => {
    expect(parseQuestionsFromPreview('')).toEqual({ questions: [], truncated: true });
  });

  it('parses a complete single question', () => {
    const input = JSON.stringify({
      questions: [
        {
          question: 'Which approach?',
          header: 'Approach',
          multiSelect: false,
          options: [
            { label: 'A', description: 'first' },
            { label: 'B', description: 'second' },
          ],
        },
      ],
    });
    const { questions, truncated } = parseQuestionsFromPreview(input);
    expect(truncated).toBe(false);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      question: 'Which approach?',
      header: 'Approach',
      multiSelect: false,
    });
    expect(questions[0].options).toEqual([
      { label: 'A', description: 'first' },
      { label: 'B', description: 'second' },
    ]);
  });

  it('preserves option preview when present', () => {
    const input = JSON.stringify({
      questions: [
        {
          question: 'Pick layout',
          header: 'Layout',
          multiSelect: false,
          options: [
            { label: 'X', description: 'd', preview: '<x>' },
            { label: 'Y', description: 'd' },
          ],
        },
      ],
    });
    const { questions } = parseQuestionsFromPreview(input);
    expect(questions[0].options[0].preview).toBe('<x>');
    expect(questions[0].options[1].preview).toBeUndefined();
  });

  it('reports truncated when input ends with … (Claude Code suffix)', () => {
    // Simulate Claude Code's St7: slice(0, 200) + '…'
    const big = JSON.stringify({
      questions: [
        {
          question: 'Q'.repeat(100),
          header: 'H',
          multiSelect: false,
          options: [
            { label: 'A', description: 'd'.repeat(80) },
            { label: 'B', description: 'd'.repeat(80) },
          ],
        },
      ],
    });
    const truncated = big.slice(0, 200) + '…';
    const result = parseQuestionsFromPreview(truncated);
    expect(result.truncated).toBe(true);
    // JSON is invalid after truncation → questions empty.
    expect(result.questions).toEqual([]);
  });

  it('reports truncated when input ends with ... (ASCII fallback)', () => {
    const result = parseQuestionsFromPreview('{"questions":[...');
    expect(result.truncated).toBe(true);
    expect(result.questions).toEqual([]);
  });

  it('returns truncated=true when JSON is unparseable (no suffix)', () => {
    const result = parseQuestionsFromPreview('not json');
    expect(result.truncated).toBe(true);
    expect(result.questions).toEqual([]);
  });

  it('skips questions missing `question` string', () => {
    const input = JSON.stringify({
      questions: [
        { header: 'X', options: [{ label: 'a', description: '' }] },
        { question: 'Real?', options: [{ label: 'yes', description: '' }, { label: 'no', description: '' }] },
      ],
    });
    const { questions } = parseQuestionsFromPreview(input);
    expect(questions).toHaveLength(1);
    expect(questions[0].question).toBe('Real?');
  });

  it('skips options without a label string', () => {
    const input = JSON.stringify({
      questions: [
        {
          question: 'q',
          header: 'h',
          multiSelect: false,
          options: [
            { description: 'no label' },
            { label: '', description: 'empty' },
            { label: 'ok', description: 'kept' },
            null,
            42,
          ],
        },
      ],
    });
    const { questions } = parseQuestionsFromPreview(input);
    expect(questions).toHaveLength(1);
    expect(questions[0].options).toEqual([{ label: 'ok', description: 'kept' }]);
  });

  it('skips entire question when no usable option survives', () => {
    const input = JSON.stringify({
      questions: [
        { question: 'q', options: [{ description: 'no label' }] },
      ],
    });
    const { questions } = parseQuestionsFromPreview(input);
    expect(questions).toEqual([]);
  });

  it('returns empty for non-object JSON (e.g. array)', () => {
    const { questions } = parseQuestionsFromPreview(JSON.stringify([1, 2, 3]));
    expect(questions).toEqual([]);
  });

  it('handles missing multiSelect/header gracefully', () => {
    const input = JSON.stringify({
      questions: [
        {
          question: 'q',
          options: [{ label: 'a', description: '' }, { label: 'b', description: '' }],
        },
      ],
    });
    const { questions } = parseQuestionsFromPreview(input);
    expect(questions[0].multiSelect).toBe(false);
    expect(questions[0].header).toBe('');
  });
});
