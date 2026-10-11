import { defineBrowserCommand, playwright } from '@vitest/browser-playwright';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

/**
 * Scroll with a real mouse wheel.
 *
 * Setting `scrollTop` from a test is not the same input and cannot stand in
 * for this. A script-driven scroll is one of the documented suppression
 * triggers for Chromium's own scroll anchoring, so a test that scrolls that
 * way silently turns off a browser feature that is very much on in the app —
 * and the app's list does its own anchoring, so what the user actually gets is
 * both corrections at once. A wheel event dispatched from JavaScript is no
 * better: it is untrusted, so it performs no default scrolling at all.
 *
 * Driving Playwright's mouse produces the same trusted input a user does.
 * `hover()` first, because the wheel goes wherever the pointer is and the
 * tests run inside the runner's iframe — Playwright resolves that offset,
 * which hand-computed page coordinates would get wrong.
 */
const wheel = defineBrowserCommand<[selector: string, deltaY: number]>(
  async ({ iframe, page }, selector, deltaY) => {
    await iframe.locator(selector).first().hover();
    await page.mouse.wheel(0, deltaY);
  },
);

/**
 * Tests that need a real layout engine.
 *
 * Deliberately a separate config, a separate file pattern and a separate npm
 * script. Two reasons:
 *
 *  - The default suite runs in happy-dom, which has no layout: every height
 *    and offset reads as 0. That is fine for logic and useless for anything
 *    about scrolling, and stubbing heights around it produced tests that
 *    passed against broken code three times in a row. Anything that depends on
 *    real geometry belongs here instead.
 *  - It stays out of CI. The `verify` job runs on a 5.7Gi swapless shared
 *    runner that is already OOM-killed by `npm ci` under contention, and
 *    adding a browser to it would be asking for trouble. These are run locally
 *    with `npm run test:browser`.
 *
 * Only `*.browser.test.ts` files are picked up, so a test lands here by being
 * named for it rather than by accident.
 */
export default defineConfig({
  plugins: [vue()],
  test: {
    include: ['src/**/*.browser.test.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
      // Fixed so geometry assertions mean the same thing on every machine.
      viewport: { width: 1280, height: 800 },
      // Nothing here is a visual regression test, and failure screenshots
      // would write files into the repo on every red run.
      screenshotFailures: false,
      commands: { wheel },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
});
