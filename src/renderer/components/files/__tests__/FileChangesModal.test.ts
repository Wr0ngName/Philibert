/**
 * "Show changes" for a file: in a git repository, what is not committed yet
 * or else its last commit; outside one, Claude's edits in the last turn.
 */

import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineComponent } from 'vue';

import type { ChatMessage, FileChanges } from '@shared/types';

vi.mock('../../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { useChatStore } from '../../../stores/chat';
import FileChangesModal from '../FileChangesModal.vue';

const WORKDIR = '/home/u/notes';
const FILE = `${WORKDIR}/todo.md`;

const ModalStub = defineComponent({
  props: { open: Boolean, title: { type: String, default: '' } },
  template: '<div v-if="open" class="modal-stub"><h2>{{ title }}</h2><slot /></div>',
});

const fileChanges = vi.fn<(dir: string, file: string) => Promise<FileChanges>>();

beforeEach(() => {
  setActivePinia(createPinia());
  fileChanges.mockReset();
  (window as unknown as { electron: unknown }).electron = { git: { fileChanges } };
});

async function show() {
  const modal = mount(FileChangesModal, {
    props: { open: true, filePath: FILE, workingDirectory: WORKDIR },
    global: { stubs: { Modal: ModalStub, Spinner: true } },
  });
  await flushPromises();
  return modal;
}

describe('in a git repository', () => {
  it('shows what is not committed yet, line by line', async () => {
    fileChanges.mockResolvedValue({ source: 'uncommitted', patch: '@@ -1 +1 @@\n-old\n+new' });

    const modal = await show();

    expect(fileChanges).toHaveBeenCalledWith(WORKDIR, FILE);
    expect(modal.find('h2').text()).toBe('Changes: todo.md');
    expect(modal.find('.file-changes-source').text()).toBe('Not committed yet');
    const lines = modal.findAll('.file-changes-patch > div');
    expect(lines.map((l) => l.text())).toEqual(['@@ -1 +1 @@', '-old', '+new']);
    expect(lines[1].classes()).toContain('text-red-800');
    expect(lines[2].classes()).toContain('text-green-800');
  });

  it('shows its last commit, named, when nothing is uncommitted', async () => {
    fileChanges.mockResolvedValue({
      source: 'last-commit',
      patch: '+added',
      commit: { hash: 'abcdef1234', shortHash: 'abcdef1', subject: 'Add the list', author: 'Ada', date: '2026-11-09T10:00:00+01:00' },
    });

    const modal = await show();

    expect(modal.find('.file-changes-source').text()).toBe('Last commit abcdef1');
    expect(modal.find('.file-changes-detail').text()).toContain('Add the list — Ada');
  });

  it('says when there is nothing to show', async () => {
    fileChanges.mockResolvedValue({ source: 'none' });

    const modal = await show();

    expect(modal.find('.file-changes-empty').text()).toContain('no commit has touched this file');
  });
});

describe('outside a git repository', () => {
  function turn(...messages: Partial<ChatMessage>[]): void {
    const chat = useChatStore();
    chat.setCurrentConversation('conv-1');
    for (const [i, message] of messages.entries()) {
      chat.addMessage({ id: `m${i}`, role: 'assistant', content: '', timestamp: i, ...message } as ChatMessage);
    }
  }
  const edit = (old_string: string, new_string: string, status = 'executed') => ({
    toolUse: { actionId: old_string, toolName: 'Edit', description: '', status, input: { file_path: FILE, old_string, new_string } },
  }) as Partial<ChatMessage>;

  it("shows Claude's edits to the file in the last turn only", async () => {
    fileChanges.mockResolvedValue({ source: 'not-a-repository' });
    turn(
      { role: 'user', content: 'first request' },
      edit('earlier', 'turn'),
      { role: 'user', content: 'second request' },
      edit('a', 'b'),
      edit('c', 'd', 'rejected'),
    );

    const modal = await show();

    expect(modal.find('.file-changes-source').text()).toBe("Claude's edits in the last turn");
    expect(modal.find('.file-changes-detail').text()).toBe('· Not a git repository');
    expect(modal.findAll('.file-changes-patch > div').map((l) => l.text())).toEqual(['@@ Edit @@', '-a', '+b']);
  });

  it('says why there is nothing, when Claude made no edit to it', async () => {
    fileChanges.mockResolvedValue({ source: 'not-a-repository' });
    turn({ role: 'user', content: 'run the formatter' });

    const modal = await show();

    expect(modal.find('.file-changes-empty').text()).toContain("can't be shown outside a git repository");
  });
});

it('says what went wrong when the changes cannot be read', async () => {
  fileChanges.mockRejectedValue(new Error('Failed to get file changes: git not found'));

  const modal = await show();

  expect(modal.find('.file-changes-failure').text()).toBe('Failed to get file changes: git not found');
});
