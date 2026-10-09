/**
 * Shell UI state: which overlay panels are open.
 *
 * These were local refs in App.vue, which is fine while a button next to them
 * is the only thing that opens them. Slash commands changed that: `/mcp` has
 * to open Settings scrolled to Tool Servers, and the command dispatcher is
 * nowhere near App.vue's template. A store keeps one owner of the state
 * instead of threading callbacks through the component tree.
 *
 * The setup wizard deliberately stays in App.vue: it is driven by setup state
 * rather than by anything a user can ask for.
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';

/** A region of the settings panel a command can ask to be shown. */
export type SettingsSection = 'auth' | 'mcp';

export const useUiStore = defineStore('ui', () => {
  const showSettings = ref(false);
  const showAbout = ref(false);
  const showSearch = ref(false);

  /**
   * Section the settings panel should scroll to once it is open.
   *
   * Read through takeSettingsSection(), which clears it. If it stayed set, the
   * panel would jump back to that section on every subsequent open — so
   * running `/mcp` once would make Settings always open at Tool Servers.
   */
  const pendingSettingsSection = ref<SettingsSection | null>(null);

  function openSettings(section: SettingsSection | null = null): void {
    pendingSettingsSection.value = section;
    showSettings.value = true;
  }

  function closeSettings(): void {
    showSettings.value = false;
    pendingSettingsSection.value = null;
  }

  /** The requested section, consumed: a second call returns null. */
  function takeSettingsSection(): SettingsSection | null {
    const section = pendingSettingsSection.value;
    pendingSettingsSection.value = null;
    return section;
  }

  function openAbout(): void {
    showAbout.value = true;
  }

  function closeAbout(): void {
    showAbout.value = false;
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
    showAbout,
    showSearch,
    pendingSettingsSection,
    markdownViewerPath,
    showRewind,
    openSettings,
    closeSettings,
    takeSettingsSection,
    openAbout,
    closeAbout,
    openSearch,
    closeSearch,
    openMarkdownViewer,
    closeMarkdownViewer,
    openRewind,
    closeRewind,
  };
});
