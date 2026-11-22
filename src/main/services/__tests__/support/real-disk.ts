/**
 * For tests that write durably to a real temporary directory: every save
 * they make is flushed to the disk (fsync), as the app's are, and is only
 * as fast as the disk is at that moment.
 *
 * Alone, such a test takes well under a second. Run in the full suite —
 * every test file at once, many of them writing — one flush can wait for the
 * others: a test of ConversationService.list.test.ts that takes 170 ms there
 * took over five seconds once and failed on the default timeout, with no
 * stray process, nothing else running, and every run of it before and after
 * passing. What it waited on was the disk, not the code under test, so the
 * time it is given is the disk's: set once per such file with
 * `vi.setConfig({ testTimeout: REAL_DISK_TEST_TIMEOUT_MS })`.
 *
 * The same holds for a test that runs real processes: release-notes.test.ts
 * runs the release-notes command — git, then git-cliff through npx — in a
 * temporary repository, about a second alone; in the full suite one took
 * over six seconds and failed on the default timeout. Each such file sets it
 * on the tests that run them.
 *
 * Not a cover for a slow test: one that takes long alone is still slow, and
 * every test here stays at a second or less on its own.
 */
export const REAL_DISK_TEST_TIMEOUT_MS = 30_000;
