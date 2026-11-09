/**
 * A closed folder holding a file Claude changed shows a ring, as the file's
 * own dot is hidden inside it.
 *
 * Asked for: a change inside a collapsed folder was invisible from the tree.
 */

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { FileNode } from '@shared/types';

import { useChatStore } from '../../../stores/chat';
import { useFilesStore } from '../../../stores/files';
import FileTreeItem from '../FileTreeItem.vue';

const SRC: FileNode = { name: 'src', path: '/p/src', type: 'directory' };

beforeEach(() => {
  setActivePinia(createPinia());
  (window as unknown as { electron: unknown }).electron = {
    files: { listDirectory: vi.fn(async () => []) },
  };
  useChatStore().setCurrentConversation('conv-1');
});

function changed(path: string): void {
  useChatStore().trackFileModification('conv-1', path);
}

function mountFolder(node: FileNode = SRC) {
  return mount(FileTreeItem, {
    props: { node },
    global: { stubs: { Icon: true, TransitionFade: { template: '<div><slot /></div>' } } },
  });
}

describe('a closed folder', () => {
  it('shows a ring when a file somewhere inside it was changed', () => {
    changed('/p/src/lib/deep/util.ts');

    const folder = mountFolder();

    expect(folder.find('.modified-inside-marker').exists()).toBe(true);
    expect(folder.find('.modified-marker').exists()).toBe(false);
  });

  it('shows none when nothing inside it was changed', () => {
    changed('/p/README.md');
    // Shares the name's start, not the folder.
    changed('/p/src2/a.ts');

    expect(mountFolder().find('.modified-inside-marker').exists()).toBe(false);
  });

  it('drops the ring once opened, its files showing their own marks', async () => {
    changed('/p/src/a.ts');
    const folder = mountFolder();

    useFilesStore().expandDirectory('/p/src');
    await folder.vm.$nextTick();

    expect(folder.find('.modified-inside-marker').exists()).toBe(false);
  });
});
