/**
 * Which files a tool call modifies, for the file tree's "modified" indicator.
 *
 * The indicator was fed from one branch only — the permission prompt's
 * Approve handler — so it appeared on a fraction of the files that had
 * actually changed: every auto-approved write was invisible, as was anything
 * after an "always allow" and everything under acceptEdits or
 * bypassPermissions. It also mapped only Edit and Write, leaving MultiEdit
 * and NotebookEdit untracked even when prompted.
 */

import { describe, it, expect } from 'vitest';

import { isFileWritingTool, modifiedPathsForTool } from '../file-modifications';

describe('isFileWritingTool', () => {
  it('covers every tool the permission cache treats as an edit', () => {
    // SessionPermissionCache's acceptEdits list is the authority on which
    // tools write files; this must not fall behind it.
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(isFileWritingTool(tool)).toBe(true);
    }
  });

  it('covers the Anthropic-defined text editor tool', () => {
    expect(isFileWritingTool('str_replace_based_edit_tool')).toBe(true);
  });

  it('excludes Bash', () => {
    // A shell line can write anywhere and the paths are not knowable from
    // the input; the file watcher covers those.
    expect(isFileWritingTool('Bash')).toBe(false);
  });

  it('excludes read-only tools', () => {
    for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'Task']) {
      expect(isFileWritingTool(tool)).toBe(false);
    }
  });
});

describe('modifiedPathsForTool', () => {
  it('reads file_path for the common edit tools', () => {
    expect(modifiedPathsForTool('Edit', { file_path: '/a/b.ts' })).toEqual(['/a/b.ts']);
    expect(modifiedPathsForTool('Write', { file_path: '/a/c.ts' })).toEqual(['/a/c.ts']);
    expect(modifiedPathsForTool('MultiEdit', { file_path: '/a/d.ts' })).toEqual(['/a/d.ts']);
  });

  it('reads notebook_path for NotebookEdit', () => {
    // A different key, which is part of why this tool was never tracked.
    expect(modifiedPathsForTool('NotebookEdit', { notebook_path: '/a/n.ipynb' }))
      .toEqual(['/a/n.ipynb']);
  });

  it('reads path for the text editor tool', () => {
    expect(modifiedPathsForTool('str_replace_based_edit_tool', { command: 'str_replace', path: '/a/e.ts' }))
      .toEqual(['/a/e.ts']);
  });

  it('reports nothing for a text editor view, which only reads', () => {
    // Marking an inspected file as modified would make the indicator
    // meaningless in the other direction.
    expect(modifiedPathsForTool('str_replace_based_edit_tool', { command: 'view', path: '/a/e.ts' }))
      .toEqual([]);
  });

  it('reports nothing for a non-writing tool even with a path in its input', () => {
    expect(modifiedPathsForTool('Read', { file_path: '/a/b.ts' })).toEqual([]);
    expect(modifiedPathsForTool('Bash', { command: 'rm -rf /a/b.ts' })).toEqual([]);
  });

  it('reports nothing for absent or pathless input', () => {
    expect(modifiedPathsForTool('Edit', undefined)).toEqual([]);
    expect(modifiedPathsForTool('Edit', null)).toEqual([]);
    expect(modifiedPathsForTool('Edit', {})).toEqual([]);
  });

  it('ignores a blank or non-string path', () => {
    expect(modifiedPathsForTool('Edit', { file_path: '   ' })).toEqual([]);
    expect(modifiedPathsForTool('Edit', { file_path: 42 })).toEqual([]);
  });

  it('returns one path even when several keys are present', () => {
    // The keys are alternative spellings for the same target, not separate
    // files, so they must not multiply into duplicate entries.
    expect(modifiedPathsForTool('Edit', { file_path: '/a/b.ts', path: '/a/b.ts' }))
      .toEqual(['/a/b.ts']);
  });
});
