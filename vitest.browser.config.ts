import { playwright } from '@vitest/browser-playwright';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

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
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
});
