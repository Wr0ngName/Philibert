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

import { claudeEditsPatch, isFileWritingTool, modifiedPathsForTool } from '../file-modifications';

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

// "Show changes" on a file outside a git repository: Claude's own edits.
describe('claudeEditsPatch', () => {
  const FILE = '/p/notes.md';
  const ran = (toolName: string, input: Record<string, unknown>) => ({ toolName, input, status: 'executed' });

  it("shows an edit as what it took out, then what it put in", () => {
    expect(claudeEditsPatch([ran('Edit', { file_path: FILE, old_string: 'a\nb', new_string: 'c' })], FILE))
      .toBe('@@ Edit @@\n-a\n-b\n+c');
  });

  it('shows every edit of a multi-edit, and a whole-file write as written', () => {
    const patch = claudeEditsPatch([
      ran('Write', { file_path: FILE, content: 'one\ntwo\n' }),
      ran('MultiEdit', { file_path: FILE, edits: [
        { old_string: 'one', new_string: '1' },
        { old_string: 'two', new_string: '2', replace_all: true },
      ] }),
    ], FILE);

    expect(patch).toBe([
      '@@ Write: the whole file @@', '+one', '+two',
      '@@ Edit 1 of 2 @@', '-one', '+1',
      '@@ Edit 2 of 2, every occurrence @@', '-two', '+2',
    ].join('\n'));
  });

  it('covers the text editor tool and notebook edits', () => {
    expect(claudeEditsPatch([
      ran('str_replace_based_edit_tool', { command: 'str_replace', path: FILE, old_str: 'x', new_str: 'y' }),
      ran('str_replace_based_edit_tool', { command: 'insert', path: FILE, insert_line: 3, new_str: 'z' }),
    ], FILE)).toBe('@@ Edit @@\n-x\n+y\n@@ Insert after line 3 @@\n+z');
    expect(claudeEditsPatch([ran('NotebookEdit', { notebook_path: '/p/n.ipynb', cell_id: 'c1', edit_mode: 'delete' })], '/p/n.ipynb'))
      .toBe('@@ NotebookEdit: delete cell c1 @@');
  });

  it('leaves out other files, calls that did not run, and reads', () => {
    expect(claudeEditsPatch([
      ran('Edit', { file_path: '/p/other.md', old_string: 'a', new_string: 'b' }),
      { toolName: 'Edit', input: { file_path: FILE, old_string: 'a', new_string: 'b' }, status: 'rejected' },
      ran('Read', { file_path: FILE }),
      ran('str_replace_based_edit_tool', { command: 'view', path: FILE }),
    ], FILE)).toBeNull();
  });

  it('matches the path whichever separator it was written with', () => {
    expect(claudeEditsPatch([ran('Edit', { file_path: 'C:\\p\\a.ts', old_string: 'a', new_string: 'b' })], 'C:/p/a.ts'))
      .toBe('@@ Edit @@\n-a\n+b');
  });
});
