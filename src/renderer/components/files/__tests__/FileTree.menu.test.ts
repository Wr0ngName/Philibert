/**
 * The file panel's right-click menu: on a file, open it, show it in the file
 * manager, show its changes, copy its path; on a folder, open it in the file
 * manager or copy its path.
 *
 * Asked for: shortcuts for what is otherwise done outside the app.
 */

import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineComponent } from 'vue';

vi.mock('../../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { useFilesStore } from '../../../stores/files';
import { useSettingsStore } from '../../../stores/settings';
import FileTree from '../FileTree.vue';

const WORKDIR = '/home/u/proj';

/** The menu, its items as buttons, open or not. */
const ContextMenuStub = defineComponent({
  props: { open: Boolean, x: { type: Number, default: 0 }, y: { type: Number, default: 0 }, items: { type: Array, default: () => [] } },
  emits: ['close'],
  template: `<div v-if="open" class="menu-stub">
    <button v-for="item in items" :key="item.label" class="menu-item" @click="$emit('close'); item.onSelect()">{{ item.label }}</button>
  </div>`,
});

const electron = {
  files: {
    listDirectory: vi.fn(),
    onChange: vi.fn(() => () => {}),
    open: vi.fn(async () => ({ success: true })),
    showInFolder: vi.fn(async () => ({ success: true })),
  },
  clipboard: { writeText: vi.fn(async () => undefined) },
  git: { fileChanges: vi.fn(async () => ({ source: 'none' })) },
};

beforeEach(async () => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  (window as unknown as { electron: unknown }).electron = electron;
  useSettingsStore().config.workingDirectory = WORKDIR;
  useFilesStore().fileTree = [
    { name: 'src', path: `${WORKDIR}/src`, type: 'directory' },
    { name: 'app.ts', path: `${WORKDIR}/app.ts`, type: 'file' },
  ];
});

function mountTree() {
  return mount(FileTree, {
    global: {
      stubs: { ContextMenu: ContextMenuStub, FileChangesModal: true, Spinner: true, Icon: true, MarkdownViewerModal: true },
    },
  });
}

async function rightClick(tree: ReturnType<typeof mountTree>, name: string) {
  const row = tree.findAll('button').find((b) => b.text() === name)!;
  await row.trigger('contextmenu', { clientX: 10, clientY: 20 });
  return tree.findAll('.menu-item');
}

async function choose(tree: ReturnType<typeof mountTree>, label: string) {
  await tree.findAll('.menu-item').find((b) => b.text() === label)!.trigger('click');
  await flushPromises();
}

describe('the menu of a file', () => {
  it('offers to open it, show it, show its changes and copy its path', async () => {
    const tree = mountTree();

    const items = await rightClick(tree, 'app.ts');

    expect(items.map((i) => i.text())).toEqual([
      'Open with default app', 'Show in file manager', 'Show changes', 'Copy path', 'Copy relative path',
    ]);
  });

  it('opens it, and shows it in the file manager', async () => {
    const tree = mountTree();
    await rightClick(tree, 'app.ts');
    await choose(tree, 'Open with default app');
    await rightClick(tree, 'app.ts');
    await choose(tree, 'Show in file manager');

    expect(electron.files.open).toHaveBeenCalledWith(`${WORKDIR}/app.ts`);
    expect(electron.files.showInFolder).toHaveBeenCalledWith(`${WORKDIR}/app.ts`);
  });

  it('copies its path, and its path in the working directory', async () => {
    const tree = mountTree();
    await rightClick(tree, 'app.ts');
    await choose(tree, 'Copy path');
    await rightClick(tree, 'app.ts');
    await choose(tree, 'Copy relative path');

    expect(electron.clipboard.writeText.mock.calls).toEqual([[`${WORKDIR}/app.ts`], ['app.ts']]);
  });

  it('does not offer the changes of a video, which nothing here shows', async () => {
    useFilesStore().fileTree = [{ name: 'clip.mp4', path: `${WORKDIR}/clip.mp4`, type: 'file' }];
    const tree = mountTree();

    const items = await rightClick(tree, 'clip.mp4');

    expect(items.map((i) => i.text())).not.toContain('Show changes');
    expect(items.map((i) => i.text())).toContain('Open with default app');
  });

  it('shows its changes', async () => {
    const tree = mountTree();
    await rightClick(tree, 'app.ts');
    await choose(tree, 'Show changes');

    const modal = tree.findComponent({ name: 'FileChangesModal' });
    expect(modal.props('open')).toBe(true);
    expect(modal.props('filePath')).toBe(`${WORKDIR}/app.ts`);
  });
});

describe('the menu of a folder', () => {
  it('offers to open it in the file manager and copy its path, not to show changes', async () => {
    const tree = mountTree();

    const items = await rightClick(tree, 'src');
    expect(items.map((i) => i.text())).toEqual(['Open in file manager', 'Copy path', 'Copy relative path']);

    await choose(tree, 'Open in file manager');
    expect(electron.files.open).toHaveBeenCalledWith(`${WORKDIR}/src`);
  });
});
