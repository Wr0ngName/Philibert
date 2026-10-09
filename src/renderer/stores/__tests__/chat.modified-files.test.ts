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

  it('records a watcher change while a query is running', () => {
    // The Bash case: a file written by a shell command. Its path is not in
    // any tool input, so the watcher is the only thing that sees it.
    const store = useChatStore();
    store.setLoading(CONV, true);

    store.trackWatcherModification('/repo/dist/bundle.js');

    expect(modified(store)).toEqual(['/repo/dist/bundle.js']);
  });

  it('ignores a watcher change when no query is running', () => {
    // Otherwise every save in the user's own editor would mark files as
    // though Claude had changed them — indistinguishable from a real edit,
    // and worse than the under-reporting this replaced.
    const store = useChatStore();
    store.setLoading(CONV, false);

    store.trackWatcherModification('/repo/src/typed-by-hand.ts');

    expect(modified(store)).toEqual([]);
  });

  it('attributes a watcher change to every running conversation', () => {
    // The watcher reports a path, not a cause. With two queries in flight,
    // picking one owner would be invention.
    const store = useChatStore();
    store.setLoading(CONV, true);
    store.setLoading('conv-2', true);

    store.trackWatcherModification('/repo/shared.ts');

    expect(modified(store)).toEqual(['/repo/shared.ts']);
    expect([...store.getConversationState('conv-2').modifiedFilesInLastQuery])
      .toEqual(['/repo/shared.ts']);
  });

  it('does not attribute a watcher change to an idle conversation', () => {
    const store = useChatStore();
    store.setLoading(CONV, true);
    store.setLoading('conv-idle', false);

    store.trackWatcherModification('/repo/shared.ts');

    expect([...store.getConversationState('conv-idle').modifiedFilesInLastQuery]).toEqual([]);
  });

  it('merges watcher and tool-derived paths without duplicating', () => {
    const store = useChatStore();
    store.setLoading(CONV, true);
    store.addAutoToolUseMessage(CONV, capture());
    store.updateToolUseResult(CONV, result('toolu_1'));

    // The watcher also sees the write the Edit tool just made.
    store.trackWatcherModification('/repo/src/a.ts');
    store.trackWatcherModification('/repo/dist/out.js');

    expect(modified(store)).toEqual(['/repo/dist/out.js', '/repo/src/a.ts']);
  });

  it('clears between queries', () => {
    const store = useChatStore();
    store.addAutoToolUseMessage(CONV, capture());
    store.updateToolUseResult(CONV, result('toolu_1'));

    store.clearModifiedFiles(CONV);

    expect(modified(store)).toEqual([]);
  });
});
