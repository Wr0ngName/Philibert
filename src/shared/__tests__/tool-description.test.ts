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

  it('names a web search by its query, and a fetch by the address it fetched', () => {
    expect(describeToolUse('WebSearch', { query: 'electron 42 release notes', allowed_domains: ['electronjs.org'] }))
      .toBe('Web search: electron 42 release notes');
    expect(describeToolUse('WebFetch', { url: 'https://docs.gitlab.com/ee/api/packages.html', prompt: 'How are packages listed?' }))
      .toBe('Fetch: https://docs.gitlab.com/ee/api/packages.html');
  });

  it('adds nothing to a web search or fetch whose input names nothing', () => {
    expect(describeToolUse('WebSearch', { query: '  ' })).toBe('');
    expect(describeToolUse('WebFetch', { prompt: 'Summarise' })).toBe('');
  });

  // Reported: a TaskUpdate row said nothing of what it did. The inputs are
  // the CLI's, as its transcripts record them.
  it('says what a task update does to which task', () => {
    expect(describeToolUse('TaskUpdate', { taskId: '1', status: 'in_progress' })).toBe('Task #1: in progress');
    expect(describeToolUse('TaskUpdate', { taskId: '1', status: 'completed' })).toBe('Task #1: completed');
    expect(describeToolUse('TaskUpdate', { taskId: '1', status: 'pending' })).toBe('Task #1: back to pending');
    expect(describeToolUse('TaskUpdate', { taskId: '1', status: 'deleted' })).toBe('Task #1: deleted');
    expect(describeToolUse('TaskUpdate', { taskId: '2', addBlockedBy: ['1'] })).toBe('Task #2: blocked by #1');
    expect(describeToolUse('TaskUpdate', { taskId: '2', addBlocks: ['3', '4'], owner: 'researcher' }))
      .toBe('Task #2: owner researcher, blocks #3, #4');
    expect(describeToolUse('TaskUpdate', { taskId: '4', subject: 'Merge main', activeForm: 'Merging main' }))
      .toBe('Task #4: renamed to "Merge main", progress line updated');
    expect(describeToolUse('TaskUpdate', { taskId: '5', metadata: { k: null } })).toBe('Task #5: metadata updated');
  });

  it("does not take a task's new description for what the update is for", () => {
    const description = 'Living docs converted to symbol anchors. The two audit reports deliberately keep their line citations.';
    expect(describeToolUse('TaskUpdate', { taskId: '9', description })).toBe('Task #9: description updated');
    expect(describeToolUse('TaskUpdate', { taskId: '13', status: 'completed', description }))
      .toBe('Task #13: completed, description updated');
  });

  it('names the task alone when an update changes nothing it can name', () => {
    expect(describeToolUse('TaskUpdate', { taskId: '3' })).toBe('Task #3');
    expect(describeToolUse('TaskUpdate', { taskId: '3', status: 'bogus' })).toBe('Task #3');
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
