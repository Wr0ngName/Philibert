/**
 * Recording which files a query modified, for the file tree indicator.
 *
 * Tracking used to happen in exactly one place: the permission prompt's
 * Approve handler in useClaudeChat. So a file was marked only when the user
 * clicked Approve for it. Auto-approved writes — everything after an "always
 * allow", and everything under acceptEdits or bypassPermissions — were never
 * recorded, which is why the indicator showed on far fewer files than had
 * changed. The store now records on execution instead, whatever route the
 * tool took.
 */

import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach } from 'vitest';

import type { ToolCaptureData } from '../../../shared/types';
import { useChatStore } from '../chat';

const CONV = 'conv-1';

function capture(overrides: Partial<ToolCaptureData> = {}): ToolCaptureData {
  return {
    toolUseBlockId: 'toolu_1',
    toolName: 'Edit',
    description: 'Edit file',
    input: { file_path: '/repo/src/a.ts' },
    ...overrides,
  } as ToolCaptureData;
}

/** A tool result; outputFile is required on the type, empty when there is none. */
function result(toolUseBlockId: string): { toolUseBlockId: string; outputFile: string; content: string } {
  return { toolUseBlockId, outputFile: '', content: 'ok' };
}

function modified(store: ReturnType<typeof useChatStore>): string[] {
  return [...store.modifiedFilesInLastQuery].sort();
}

beforeEach(() => {
  setActivePinia(createPinia());
  const store = useChatStore();
  store.setCurrentConversation(CONV);
});

describe('modified file tracking', () => {
  it('records an auto-approved edit, which was never tracked before', () => {
    // The whole bug: no Approve click, so nothing was recorded.
    const store = useChatStore();
    store.addAutoToolUseMessage(CONV, capture());
    store.updateToolUseResult(CONV, result('toolu_1'));

    expect(modified(store)).toEqual(['/repo/src/a.ts']);
  });

  it('records NotebookEdit, which the prompt path never classified', () => {
    const store = useChatStore();
    store.addAutoToolUseMessage(CONV, capture({
      toolUseBlockId: 'toolu_nb',
      toolName: 'NotebookEdit',
      input: { notebook_path: '/repo/nb.ipynb' },
    }));
    store.updateToolUseResult(CONV, result('toolu_nb'));

    expect(modified(store)).toEqual(['/repo/nb.ipynb']);
  });

  it('records every file across several edits in one query', () => {
    const store = useChatStore();
    for (const [i, path] of ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts'].entries()) {
      const id = `toolu_${i}`;
      store.addAutoToolUseMessage(CONV, capture({ toolUseBlockId: id, input: { file_path: path } }));
      store.updateToolUseResult(CONV, result(id));
    }
    expect(modified(store)).toEqual(['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']);
  });

  it('does not record a read', () => {
    const store = useChatStore();
    store.addAutoToolUseMessage(CONV, capture({
      toolName: 'Read',
      input: { file_path: '/repo/src/a.ts' },
    }));
    store.updateToolUseResult(CONV, result('toolu_1'));

    expect(modified(store)).toEqual([]);
  });

  it('does not record a tool that has not run yet', () => {
    // Keyed on execution, not invocation, so a call still awaiting
    // permission has not changed anything.
    const store = useChatStore();
    store.addToolUseMessage(CONV, {
      id: 'action-1',
      type: 'file-edit',
      toolName: 'Edit',
      description: 'Edit file',
      input: { file_path: '/repo/src/pending.ts' },
      status: 'pending',
      timestamp: Date.now(),
    } as never);

    expect(modified(store)).toEqual([]);
  });

  it('records it once the prompted tool is marked executed', () => {
    const store = useChatStore();
    store.addToolUseMessage(CONV, {
      id: 'action-1',
      type: 'file-edit',
      toolName: 'Edit',
      description: 'Edit file',
      input: { file_path: '/repo/src/prompted.ts' },
      status: 'pending',
      timestamp: Date.now(),
    } as never);

    store.updateToolUseStatus(CONV, 'action-1', 'executed');

    expect(modified(store)).toEqual(['/repo/src/prompted.ts']);
  });

  it('records tools still in flight when the turn completes', () => {
    // completeToolUseMessages sweeps anything left pending to executed; those
    // writes did happen and must not be lost.
    const store = useChatStore();
    store.addAutoToolUseMessage(CONV, capture({ input: { file_path: '/repo/src/swept.ts' } }));
    store.completeToolUseMessages(CONV);

    expect(modified(store)).toEqual(['/repo/src/swept.ts']);
  });

  it('does not double-record the same file', () => {
    const store = useChatStore();
    store.addAutoToolUseMessage(CONV, capture());
    store.updateToolUseResult(CONV, result('toolu_1'));
    store.completeToolUseMessages(CONV);

    expect(modified(store)).toEqual(['/repo/src/a.ts']);
  });

  it('clears between queries', () => {
    const store = useChatStore();
    store.addAutoToolUseMessage(CONV, capture());
    store.updateToolUseResult(CONV, result('toolu_1'));

    store.clearModifiedFiles(CONV);

    expect(modified(store)).toEqual([]);
  });
});
