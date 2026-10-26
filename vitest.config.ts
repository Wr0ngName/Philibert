import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

// Turn off Node's own Web Storage in the test workers.
//
// Node 25 puts `localStorage`/`sessionStorage` on the real global, and reading
// either without `--localstorage-file=<path>` prints "Warning:
// `--localstorage-file` was provided without a valid path".
// `@vue/devtools-kit`, which Pinia pulls in, reads localStorage at module-init
// time in getTimelineLayersStateFromStorage(), so every worker printed that
// warning — 15 per full run, in CI as well as locally.
//
// Disabling it is safe, not a workaround: nothing in src/ touches localStorage
// or sessionStorage (the app persists through electron-store), and happy-dom
// supplies its own Storage on its window regardless of this flag. devtools-kit
// guards with `typeof localStorage === "undefined"`, which on an undeclared
// identifier yields "undefined" rather than throwing, so it takes its early
// return and never touches storage. Handing Node a real path instead is worse:
// it writes a 16KB SQLite file per worker on first read.
//
// Three delivery routes were tried, and only this one works:
//  - A setup file redefining globalThis.localStorage does not reach it.
//    vitest evaluates external modules through Node's own ESM loader against
//    the real process global, while a setup file sees only the happy-dom
//    context — the warning's stack stayed at node:internal/webstorage even
//    with globalThis.localStorage confirmed replaced.
//  - `poolOptions.forks.execArgv` / `poolOptions.threads.execArgv` had no
//    effect on the forked workers (still 15 warnings, default pool and
//    --pool=forks alike).
//  - NODE_OPTIONS reaches them, and the workers inherit it from this process.
//    Set here rather than as a prefix in the npm script so `npm test` keeps
//    working on Windows, where `NODE_OPTIONS=... vitest` is not valid.
//
// The heap cap is for the CI runner (5.7GB, shared with other projects). The
// largest file holds at most ~130MB live once release-kept-objects.ts lets V8
// drop what it kept per job, but with no limit near V8 collects lazily: that
// file peaked at 1.6GB RSS of garbage, and 2GB before the fix, which timed the
// worker out on a runner with 1.7GB free. Capped, it peaks at 1.2GB with the
// same run time.
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--no-experimental-webstorage', '--max-old-space-size=1024']
  .filter(Boolean)
  .join(' ');

export default defineConfig({
  plugins: [vue()],
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/**/*.{test,spec}.ts'],
    // `*.browser.test.ts` needs a real layout engine and runs under
    // vitest.browser.config.ts (`npm run test:browser`). Here it would match
    // the include pattern and fail on happy-dom's zero heights, which is
    // exactly the false signal those tests exist to replace.
    exclude: ['node_modules', 'dist', 'src/**/*.browser.test.ts'],
    // See the file: without it, documents parsed in a test are kept alive
    // until its whole file ends.
    setupFiles: ['src/test-setup/release-kept-objects.ts'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'src/**/*.d.ts'],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
});
