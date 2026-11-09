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
    fileChanges.mockResolvedValue({ source: 'uncommitted', view: { kind: 'text', patch: '@@ -1 +1 @@\n-old\n+new' } });

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
      view: { kind: 'text', patch: '+added' },
      commit: { hash: 'abcdef1234', shortHash: 'abcdef1', subject: 'Add the list', author: 'Ada', date: '2026-11-09T10:00:00+01:00' },
    });

    const modal = await show();

    expect(modal.find('.file-changes-source').text()).toBe('Last commit abcdef1');
    expect(modal.find('.file-changes-detail').text()).toContain('Add the list — Ada');
  });

  // Reported: a 200,000-line rewrite ran past what git's output was read
  // into, and the window showed an error instead of the change.
  it('says when only the start of a large change is shown, and how large it is', async () => {
    fileChanges.mockResolvedValue({
      source: 'uncommitted',
      view: { kind: 'text', patch: '+a\n+b', truncated: { shownLines: 2000, added: 200000, removed: 200000, bytes: null } },
    });

    const modal = await show();

    expect(modal.find('.file-changes-truncated').text())
      .toBe(`Showing the first ${(2000).toLocaleString()} lines of a change of +${(200000).toLocaleString()} −${(200000).toLocaleString()} lines.`);
  });

  // Reported: a picture's change read "Binary files a/x.png and b/x.png differ".
  it('shows a picture before and after', async () => {
    fileChanges.mockResolvedValue({
      source: 'uncommitted',
      view: { kind: 'image', mediaType: 'image/png', before: 'QUJD', after: null, beforeBytes: 3, afterBytes: 20 * 1024 * 1024 },
    });

    const modal = await show();

    const sides = modal.findAll('.file-changes-image');
    expect(sides.map((s) => s.find('figcaption').text())).toEqual(['Before · 3 bytes', 'After · Too large to show (20.0 MB)']);
    expect(sides[0].find('img').attributes('src')).toBe('data:image/png;base64,QUJD');
    expect(sides[1].find('img').exists()).toBe(false);
  });

  it('shows the bytes that differ in a binary file, side by side', async () => {
    const row = (offset: number, before: string[] | null, after: string[] | null) => ({ offset, before, after });
    fileChanges.mockResolvedValue({
      source: 'uncommitted',
      view: {
        kind: 'binary', beforeBytes: 4096, afterBytes: 4100, truncated: false,
        rows: [{ skipped: 10 }, row(160, ['41', '42'], ['41', '43'])],
      },
    });

    const modal = await show();

    expect(modal.find('.file-changes-binary').text()).toContain('Binary file: 4.0 KB → 4.0 KB.');
    expect(modal.find('.hex-skipped').text()).toBe('… 10 identical rows');
    // A row that differs reads like a patch: before (-) above after (+).
    const lines = modal.findAll('.hex-row .hex-line');
    expect(lines.map((l) => l.attributes('data-side'))).toEqual(['before', 'after']);
    expect(lines[0].text()).toContain('000000a0');
    const [before, after] = lines.map((l) => l.find('.hex-bytes'));
    expect(before.findAll('span').map((s) => [s.text(), s.classes().includes('bg-red-200')])).toEqual([['41', false], ['42', true]]);
    expect(after.findAll('span').map((s) => [s.text(), s.classes().includes('bg-green-200')])).toEqual([['41', false], ['43', true]]);
    expect(lines.map((l) => l.find('.hex-text').text())).toEqual(['AB', 'AC']);
  });

  it('shows a row the same on both sides once', async () => {
    fileChanges.mockResolvedValue({
      source: 'uncommitted',
      view: { kind: 'binary', beforeBytes: 2, afterBytes: 2, truncated: false, rows: [{ offset: 0, before: ['41', '42'], after: ['41', '42'] }] },
    });

    const modal = await show();

    const lines = modal.findAll('.hex-row .hex-line');
    expect(lines.map((l) => l.attributes('data-side'))).toEqual(['both']);
  });

  it('says so when a binary file differs only further in than is compared', async () => {
    fileChanges.mockResolvedValue({
      source: 'uncommitted',
      view: { kind: 'binary', beforeBytes: 5 * 1024 * 1024, afterBytes: 5 * 1024 * 1024, truncated: true, rows: [] },
    });

    const modal = await show();

    expect(modal.find('.file-changes-hex').exists()).toBe(false);
    expect(modal.find('.file-changes-hex-none').text()).toContain('the difference is further in than is compared');
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
