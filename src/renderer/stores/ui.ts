/**
 * Shell UI state: which overlay panels are open.
 *
 * These were local refs in App.vue, which is fine while a button next to them
 * is the only thing that opens them. Slash commands changed that: `/mcp` has
 * to open Settings at its Tool servers tab, and the command dispatcher is
 * nowhere near App.vue's template. A store keeps one owner of the state
 * instead of threading callbacks through the component tree.
 *
 * The setup wizard deliberately stays in App.vue: it is driven by setup state
 * rather than by anything a user can ask for.
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';

import type { SettingsTab } from '@shared/settings-tabs';

export const useUiStore = defineStore('ui', () => {
  const showSettings = ref(false);
  const showSearch = ref(false);

  /**
   * Tab the settings dialog should turn to once it is open.
   *
   * Read through takeSettingsTab(), which clears it. If it stayed set, the
   * dialog would turn back to that tab on every later open — so running
   * `/mcp` once would make Settings always open at Tool servers.
   */
  const pendingSettingsTab = ref<SettingsTab | null>(null);

  /** Open settings, at the given tab or at the one it was last left on. */
  function openSettings(tab: SettingsTab | null = null): void {
    pendingSettingsTab.value = tab;
    showSettings.value = true;
  }

  function closeSettings(): void {
    showSettings.value = false;
    pendingSettingsTab.value = null;
  }

  /** The requested tab, consumed: a second call returns null. */
  function takeSettingsTab(): SettingsTab | null {
    const tab = pendingSettingsTab.value;
    pendingSettingsTab.value = null;
    return tab;
  }

  function openSearch(): void {
    showSearch.value = true;
  }

  function closeSearch(): void {
    showSearch.value = false;
  }

  /**
   * Path shown in the Markdown viewer, or null when it is closed.
   *
   * Shared rather than owned by the file tree, because `/memory` opens
   * CLAUDE.md in the same viewer and the sidebar may not even be visible.
   */
  const markdownViewerPath = ref<string | null>(null);

  function openMarkdownViewer(path: string): void {
    markdownViewerPath.value = path;
  }

  function closeMarkdownViewer(): void {
    markdownViewerPath.value = null;
  }

  /** Whether the rewind dialog is up. */
  const showRewind = ref(false);

  function openRewind(): void {
    showRewind.value = true;
  }

  function closeRewind(): void {
    showRewind.value = false;
  }

  return {
    showSettings,
    showSearch,
    pendingSettingsTab,
    markdownViewerPath,
    showRewind,
    openSettings,
    closeSettings,
    takeSettingsTab,
    openSearch,
    closeSearch,
    openMarkdownViewer,
    closeMarkdownViewer,
    openRewind,
    closeRewind,
  };
});
