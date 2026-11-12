/**
 * The tabs of the settings dialog, in the order they are listed.
 *
 * Shared because slash commands name the tab they open (`/login` the
 * account, `/mcp` the tools), and those are described in shared code.
 *
 * `tools` is what every project has; `project`, one project's own.
 */
export const SETTINGS_TABS = ['account', 'appearance', 'discussions', 'tools', 'project', 'advanced', 'about'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
