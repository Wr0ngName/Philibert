/**
 * Tests for the FileTree empty states.
 *
 * An empty tree has two distinct causes and they must not share a message:
 * no directory has been chosen yet, versus a directory that is chosen and
 * genuinely contains nothing.
 */

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { useFilesStore } from '../../../stores/files';
import { useSettingsStore } from '../../../stores/settings';
import FileTree from '../FileTree.vue';

function mountTree() {
  return mount(FileTree, {
    global: {
      stubs: {
        FileTreeItem: true,
        MarkdownViewerModal: true,
        Spinner: true,
        Icon: true,
      },
    },
  });
}

describe('FileTree empty states', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // The component registers a file watcher on mount.
    (globalThis as unknown as { window: Record<string, unknown> }).window.electron = {
      files: {
        getTree: vi.fn().mockResolvedValue([]),
        onFileChange: vi.fn(() => () => {}),
        watch: vi.fn(),
        unwatch: vi.fn(),
      },
    } as never;
  });

  it('says no directory is selected when none has been chosen', () => {
    const store = useFilesStore();
    useSettingsStore().config.workingDirectory = '';
    store.fileTree = [];

    const wrapper = mountTree();

    expect(wrapper.text()).toContain('No working directory selected');
    expect(wrapper.text()).not.toContain('This folder is empty');
  });

  it('says the folder is empty when a directory is selected but has no files', () => {
    const store = useFilesStore();
    useSettingsStore().config.workingDirectory = '/home/user/empty-project';
    store.fileTree = [];

    const wrapper = mountTree();

    // The old behaviour reported "No working directory selected" here, which
    // is untrue — a directory is selected, it just has nothing in it.
    expect(wrapper.text()).toContain('This folder is empty');
    expect(wrapper.text()).not.toContain('No working directory selected');
  });
});
