import { describe, it, expect } from 'vitest';

import { describeToolUse, toolCallLabel } from '../tool-description';

describe('describeToolUse', () => {
  // Reported: a PowerShell row read "PowerShell Tool: PowerShell" while the
  // background list named the same work "Run 10 bots with personas and
  // panel, 10 minutes".
  it("names a command by what it says it does, as the background list does", () => {
    expect(describeToolUse('PowerShell', {
      command: '.\\run-bots.ps1 -Count 10',
      description: 'Run 10 bots with personas and panel, 10 minutes',
    })).toBe('Run 10 bots with personas and panel, 10 minutes');
    expect(describeToolUse('Bash', { command: 'npm run build', description: 'Build the app' }))
      .toBe('Build the app');
  });

  it('falls back to the command when a command says nothing about itself', () => {
    expect(describeToolUse('PowerShell', { command: 'Get-ChildItem' })).toBe('Run: Get-ChildItem');
    expect(describeToolUse('Bash', { command: 'ls', description: '   ' })).toBe('Run: ls');
    expect(describeToolUse('Bash', { command: 'x'.repeat(200) })).toBe(`Run: ${'x'.repeat(80)}`);
  });

  it('names an agent by its description, or else by its prompt', () => {
    expect(describeToolUse('Agent', { prompt: 'Look through the logs and…', description: 'Audit the logs' }))
      .toBe('Audit the logs');
    expect(describeToolUse('Agent', { prompt: 'Look through the logs' })).toBe('Agent: Look through the logs');
  });

  it('names a message to an agent by its summary, or else by its first line, as the CLI previews it', () => {
    expect(describeToolUse('SendMessage', {
      to: 'a481e4eafefca67f3', summary: 'Also run echo hello', message: 'When you are done,\nalso run echo hello.',
    })).toBe('Also run echo hello');
    expect(describeToolUse('SendMessage', { to: 'a481e4eafefca67f3', summary: '  ', message: 'When you are done,\nalso run echo hello.' }))
      .toBe('When you are done,');
    expect(describeToolUse('SendMessage', { to: 'researcher', message: 'y'.repeat(200) })).toBe('y'.repeat(80));
    // A structured request without a summary has no line to show.
    expect(describeToolUse('SendMessage', { to: 'researcher', message: { type: 'shutdown_request' } })).toBe('');
  });

  it('keeps naming file and search calls by what they touch', () => {
    expect(describeToolUse('Read', { file_path: '/a/b.ts' })).toBe('Read: /a/b.ts');
    expect(describeToolUse('Grep', { pattern: 'todo', description: 'ignored' })).toBe('Search: todo');
  });

  it('adds nothing to the tool name for any other call that says nothing about itself', () => {
    expect(describeToolUse('mcp__gsc__query', { site: 'x' })).toBe('');
    expect(describeToolUse('mcp__gsc__query', { description: 'Top queries this week' })).toBe('Top queries this week');
  });
});

describe('toolCallLabel', () => {
  it('works the label out from the input, so a row saved with an older one reads the same', () => {
    expect(toolCallLabel({
      toolName: 'PowerShell',
      description: 'Tool: PowerShell',
      input: { command: '.\\run-bots.ps1', description: 'Run 10 bots' },
    })).toBe('Run 10 bots');
  });

  it('keeps the stored label for a call without input', () => {
    expect(toolCallLabel({ toolName: 'Bash', description: 'Run: ls' })).toBe('Run: ls');
  });
});
