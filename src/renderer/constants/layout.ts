/**
 * Bounds for what the user can resize: the sidebars and the dialogs.
 * The sizes they start at are the config defaults (DEFAULT_CONFIG).
 */

export const SIDEBAR_WIDTH = {
  /** Narrower than this and a sidebar's rows no longer read. */
  MIN: 180,
  /** Wider than this and the discussion is crowded out on a laptop screen. */
  MAX: 600,
} as const;

/**
 * Room the discussion keeps however wide the sidebars were dragged: in a
 * window too narrow for all three, the sidebars give way, down to their MIN.
 * The window's own minimum (800px) holds this and both sidebars at MIN.
 */
export const CHAT_MIN_WIDTH = 360;

export const MODAL_SIZE = {
  MIN_WIDTH: 320,
  MIN_HEIGHT: 200,
  /** Room kept between a dialog and the window's edges, on each side. */
  VIEWPORT_MARGIN: 16,
} as const;

/**
 * The settings dialog until it is resized: room for its tabs beside the
 * widest of their pages, and the same height whichever tab is shown, so
 * moving between tabs does not make the dialog jump.
 */
export const SETTINGS_DIALOG_SIZE = { width: 880, height: 680 } as const;

/** How far an arrow key moves a resize handle. */
export const RESIZE_KEY_STEP = 16;
