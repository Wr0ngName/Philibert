/**
 * Formatting a tool call's input for display.
 *
 * Shared by the tool detail modal and the background task detail modal. The
 * background modal did not show this at all, which is why a running task
 * displayed only its description, status and duration: every other field it
 * had — summary, output file, model, tokens — only arrives once the task ends.
 */

import { describe, it, expect } from 'vitest';

import { formatToolInput } from '../tool-input';

describe('formatToolInput', () => {
  it('returns nothing for absent input', () => {
    expect(formatToolInput(undefined)).toEqual([]);
    expect(formatToolInput(null)).toEqual([]);
    expect(formatToolInput({})).toEqual([]);
  });

  it('labels a shell command and gives it its own block', () => {
    // The detail that matters for a backgrounded command.
    const [param] = formatToolInput({ command: 'npm run build' });
    expect(param).toMatchObject({
      key: 'command',
      label: 'Command',
      value: 'npm run build',
      isBlock: true,
    });
  });

  it('labels an agent spawn so a subagent task reads properly', () => {
    // An 'agent' background task comes from the Task tool, whose input is the
    // prompt and the subagent type.
    const params = formatToolInput({
      subagent_type: 'reviewer',
      prompt: 'Review the diff on this branch',
    });
    const byKey = Object.fromEntries(params.map(p => [p.key, p]));
    expect(byKey.subagent_type).toMatchObject({ label: 'Agent', isBlock: false });
    expect(byKey.prompt).toMatchObject({ label: 'Prompt', isBlock: true });
  });

  it('keeps an unknown key as its own label rather than dropping it', () => {
    const [param] = formatToolInput({ some_new_field: 'x' });
    expect(param).toMatchObject({ key: 'some_new_field', label: 'some_new_field', value: 'x' });
  });

  it('pretty-prints objects and arrays instead of stringifying them', () => {
    // Without this an object renders as "[object Object]", which is the kind
    // of detail that looks present and tells you nothing.
    const [param] = formatToolInput({ edits: [{ old: 'a', new: 'b' }] });
    expect(param.value).toContain('"old": "a"');
    expect(param.value).not.toContain('[object Object]');
  });

  it('renders booleans and numbers as text', () => {
    const params = formatToolInput({ run_in_background: true, timeout: 5000 });
    const byKey = Object.fromEntries(params.map(p => [p.key, p]));
    expect(byKey.run_in_background.value).toBe('true');
    expect(byKey.timeout.value).toBe('5000');
  });

  it('keeps a present-but-unset parameter visible', () => {
    // Knowing a parameter was passed as null is information; dropping the row
    // would imply it was never passed.
    const params = formatToolInput({ cwd: null });
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({ key: 'cwd', label: 'Working Directory', value: '' });
  });

  it('blocks a long or multiline value and inlines a short one', () => {
    const long = formatToolInput({ pattern: 'x'.repeat(100) })[0];
    const multiline = formatToolInput({ pattern: 'a\nb' })[0];
    const short = formatToolInput({ pattern: 'TODO' })[0];
    expect(long.isBlock).toBe(true);
    expect(multiline.isBlock).toBe(true);
    expect(short.isBlock).toBe(false);
  });

  it('preserves input order', () => {
    const keys = formatToolInput({ b: 1, a: 2, c: 3 }).map(p => p.key);
    expect(keys).toEqual(['b', 'a', 'c']);
  });
});
