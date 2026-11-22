/**
 * The tabs of the settings dialog, in the order they are listed.
 *
 * Shared because slash commands name the tab they open (`/login` the
 * account, `/mcp` the tools), and those are described in shared code.
 *
 * Two groups, listed apart: the general settings, the same in every project
 * (`tools` is what every project has), then the project's own settings.
 */
export const GENERAL_SETTINGS_TABS = ['account', 'appearance', 'discussions', 'tools', 'advanced', 'about'] as const;
export const SETTINGS_TABS = [...GENERAL_SETTINGS_TABS, 'project'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
