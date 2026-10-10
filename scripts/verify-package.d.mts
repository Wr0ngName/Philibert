/**
 * Types for verify-package.mjs.
 *
 * The script itself stays plain JavaScript because CI runs it with a bare
 * `node scripts/verify-package.mjs` between packaging and making — there is no
 * build step at that point in the pipeline, and adding one would put more
 * machinery in front of the guard than the guard itself.
 */

/** Path of the manifest Forge's packageAfterPrune hook writes for a platform. */
export function manifestPathFor(platform: string): string;

/** Absolute path of a module inside a packaged app, or null if absent. */
export function locateModule(packageDir: string, name: string): string | null;

/**
 * Problems found with a packaged app. An empty array means it is complete.
 */
export function verifyPackage(packageDir: string, platform: string): string[];
