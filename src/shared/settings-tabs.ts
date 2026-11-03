/**
 * The tabs of the settings dialog, in the order they are listed.
 *
 * Shared because slash commands name the tab they open (`/login` the
 * account, `/mcp` the tool servers), and those are described in shared code.
 */
export const SETTINGS_TABS = ['account', 'appearance', 'discussions', 'tools', 'advanced', 'about'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
