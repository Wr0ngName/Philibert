/**
 * Tests for the shared AskUserQuestion parsers.
 *
 * PROBE_RESULT is the tool_result content the bundled CLI emitted for an
 * AskUserQuestion that Philibert answered (scratch probe, SDK 0.3.280): the
 * deny message, passed through verbatim.
 */

import { describe, it, expect } from 'vitest';

import { parseAskUserQuestionEntries, parseAskUserQuestionResult } from '../ask-user-question';

const PROBE_RESULT =
  '{"questions":[{"question":"Which color do you prefer?","header":"Color preference","options":[{"label":"Red","description":"The color red"},{"label":"Blue","description":"The color blue"}],"multiSelect":false}],"answers":{"Which color do you prefer?":"Blue"}}';

describe('parseAskUserQuestionEntries', () => {
  it('reads a well-formed question', () => {
    expect(parseAskUserQuestionEntries({
      questions: [{
        question: 'Which color?',
        header: 'Color',
        multiSelect: true,
        options: [{ label: 'Red', description: 'warm', preview: '# red' }, { label: 'Blue', description: 'cool' }],
      }],
    })).toEqual([{
      question: 'Which color?',
      header: 'Color',
      multiSelect: true,
      options: [{ label: 'Red', description: 'warm', preview: '# red' }, { label: 'Blue', description: 'cool' }],
    }]);
  });

  it('drops questions without text or usable options, and options without a label', () => {
    expect(parseAskUserQuestionEntries({
      questions: [
        { question: '', options: [{ label: 'A' }] },
        { question: 'No options', options: [] },
        { question: 'Only unlabeled', options: [{ description: 'x' }] },
        { question: 'Kept', options: [{ label: '' }, { label: 'B' }] },
        'junk',
      ],
    })).toEqual([{ question: 'Kept', header: '', multiSelect: false, options: [{ label: 'B', description: '' }] }]);
  });

  it('returns nothing for input without a questions array', () => {
    expect(parseAskUserQuestionEntries(undefined)).toEqual([]);
    expect(parseAskUserQuestionEntries({ questions: 'nope' })).toEqual([]);
  });
});

describe('parseAskUserQuestionResult', () => {
  it('parses the payload the CLI hands back', () => {
    expect(parseAskUserQuestionResult(PROBE_RESULT)).toEqual({
      questions: [{
        question: 'Which color do you prefer?',
        header: 'Color preference',
        multiSelect: false,
        options: [{ label: 'Red', description: 'The color red' }, { label: 'Blue', description: 'The color blue' }],
      }],
      answers: { 'Which color do you prefer?': 'Blue' },
    });
  });

  it('keeps notes and previews, dropping empty annotations', () => {
    const result = parseAskUserQuestionResult(JSON.stringify({
      questions: [],
      answers: { Q1: 'A', Q2: 'B' },
      annotations: { Q1: { notes: 'because' }, Q2: { other: 1 } },
    }));

    expect(result?.annotations).toEqual({ Q1: { notes: 'because' } });
  });

  it('returns null for the plain-text cancellation and other non-payloads', () => {
    expect(parseAskUserQuestionResult('User cancelled the question.')).toBeNull();
    expect(parseAskUserQuestionResult('[1, 2]')).toBeNull();
    expect(parseAskUserQuestionResult('{"questions": []}')).toBeNull();
    expect(parseAskUserQuestionResult('{"answers": ["A"]}')).toBeNull();
  });
});
