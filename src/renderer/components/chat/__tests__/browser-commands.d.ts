/**
 * Types for the custom browser commands defined in vitest.browser.config.ts.
 *
 * Commands are implemented in the Vitest server process and called from the
 * test in the browser, so the two sides share nothing but this declaration.
 */

declare module 'vitest/browser' {
  interface BrowserCommands {
    /** Scroll with a real mouse wheel over the first match for `selector`. */
    wheel(selector: string, deltaY: number): Promise<void>;
  }
}

export {};
