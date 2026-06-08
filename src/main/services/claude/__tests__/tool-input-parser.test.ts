/**
 * Tests for parseGenericToolInput / buildGenericToolDescription.
 *
 * Covers the rendering data produced for MCP / unknown tools whose inputs
 * used to be dumped as raw JSON into a bash-command card. The parser must:
 *  - pull out the input.description (string only) into a top-level field
 *  - pick a primary text field by priority (command > script > … > text)
 *  - separate multi-line vs. single-line scalar fields
 *  - serialise object/array fields to compact JSON for the disclosure section
 *  - never throw on weird/edge inputs (null, arrays, non-objects)
 */

import { describe, it, expect } from 'vitest';

import { parseGenericToolInput, buildGenericToolDescription } from '../tool-input-parser';

describe('parseGenericToolInput', () => {
  it('extracts inputDescription when description is a string', () => {
    const details = parseGenericToolInput({
      command: 'ls',
      description: 'List files',
    });
    expect(details.inputDescription).toBe('List files');
    expect(details.primaryText).toEqual({ label: 'command', content: 'ls' });
    expect(details.secondaryFields).toEqual([]);
  });

  it('preserves multi-line command content as-is for <pre> rendering', () => {
    const multiLine = 'line1\nline2\nline3';
    const details = parseGenericToolInput({ command: multiLine });
    expect(details.primaryText?.content).toBe(multiLine);
  });

  it('picks the first matching primary key by priority', () => {
    const details = parseGenericToolInput({
      script: 'echo hi',
      command: 'true',
    });
    // `command` outranks `script`
    expect(details.primaryText?.label).toBe('command');
    expect(details.primaryText?.content).toBe('true');
    // The non-primary one drops into secondaryFields
    expect(details.secondaryFields).toContainEqual({ label: 'script', value: 'echo hi', multiline: false });
  });

  it('falls back through script/code/sql/query/prompt/content/body/text', () => {
    const details = parseGenericToolInput({ prompt: 'do the thing' });
    expect(details.primaryText).toEqual({ label: 'prompt', content: 'do the thing' });
  });

  it('classifies single-line vs multi-line secondary fields', () => {
    const details = parseGenericToolInput({
      command: 'cmd',
      file_path: '/etc/hosts',
      payload: 'multi\nline\nvalue',
    });
    const file = details.secondaryFields.find((f) => f.label === 'file_path');
    const payload = details.secondaryFields.find((f) => f.label === 'payload');
    expect(file).toEqual({ label: 'file_path', value: '/etc/hosts', multiline: false });
    expect(payload).toEqual({ label: 'payload', value: 'multi\nline\nvalue', multiline: true });
  });

  it('coerces numbers and booleans into single-line secondary fields', () => {
    const details = parseGenericToolInput({ count: 42, dry: true, command: 'x' });
    expect(details.secondaryFields).toContainEqual({ label: 'count', value: '42', multiline: false });
    expect(details.secondaryFields).toContainEqual({ label: 'dry', value: 'true', multiline: false });
  });

  it('renders nested objects and arrays as pretty JSON in jsonFields', () => {
    const details = parseGenericToolInput({
      command: 'x',
      tags: ['a', 'b'],
      opts: { force: true },
    });
    const tags = details.jsonFields.find((f) => f.label === 'tags');
    const opts = details.jsonFields.find((f) => f.label === 'opts');
    expect(tags?.json).toBe(JSON.stringify(['a', 'b'], null, 2));
    expect(opts?.json).toBe(JSON.stringify({ force: true }, null, 2));
  });

  it('skips null/undefined values', () => {
    const details = parseGenericToolInput({ command: 'x', skip: null, also: undefined });
    expect(details.secondaryFields).toEqual([]);
    expect(details.jsonFields).toEqual([]);
  });

  it('non-string description is treated as a scalar field, not the subtitle', () => {
    const details = parseGenericToolInput({ command: 'x', description: 42 });
    expect(details.inputDescription).toBeUndefined();
    expect(details.secondaryFields).toContainEqual({ label: 'description', value: '42', multiline: false });
  });

  it('returns an empty details shell for non-object input (null/array/string)', () => {
    expect(parseGenericToolInput(null)).toEqual({
      rawInput: {},
      secondaryFields: [],
      jsonFields: [],
    });
    expect(parseGenericToolInput(['a', 'b'])).toEqual({
      rawInput: {},
      secondaryFields: [],
      jsonFields: [],
    });
    expect(parseGenericToolInput('hello')).toEqual({
      rawInput: {},
      secondaryFields: [],
      jsonFields: [],
    });
  });

  it('propagates the truncated flag', () => {
    const details = parseGenericToolInput(null, true);
    expect(details.truncated).toBe(true);
  });

  it('handles the PowerShell-shaped example from the bug report', () => {
    const input = {
      command: "$ErrorActionPreference = 'Stop'\n$path = 'C:\\foo.ps1'\nWrite-Host 'ok'",
      description: 'Re-parse, syntax probe, help-bind check after refactor',
    };
    const details = parseGenericToolInput(input);
    expect(details.inputDescription).toBe('Re-parse, syntax probe, help-bind check after refactor');
    expect(details.primaryText?.label).toBe('command');
    expect(details.primaryText?.content).toContain('$ErrorActionPreference');
    expect(details.primaryText?.content).toContain('\n');
    expect(details.secondaryFields).toEqual([]);
    expect(details.jsonFields).toEqual([]);
  });
});

describe('buildGenericToolDescription', () => {
  it('uses input.description when present', () => {
    const details = parseGenericToolInput({ command: 'x', description: 'Audit AD' });
    expect(buildGenericToolDescription('PowerShell', details)).toBe('PowerShell: Audit AD');
  });

  it('truncates long descriptions to keep header on one line', () => {
    const long = 'a'.repeat(120);
    const details = parseGenericToolInput({ command: 'x', description: long });
    const out = buildGenericToolDescription('PowerShell', details);
    expect(out.length).toBeLessThanOrEqual('PowerShell: '.length + 80);
    expect(out.endsWith('…')).toBe(true);
  });

  it('falls back to "Tool: <name>" when description is missing', () => {
    const details = parseGenericToolInput({ command: 'x' });
    expect(buildGenericToolDescription('WebFetch', details)).toBe('Tool: WebFetch');
  });
});
