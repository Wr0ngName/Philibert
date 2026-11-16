/**
 * Types for release-notes.mjs, plain JavaScript for the same reason as
 * verify-package.mjs: CI runs it with a bare `node` and no build step.
 */

export function baseVersion(tag: string): string;
export function isStable(tag: string): boolean;
export function whatsNew(changelog: string, version: string): string | null;
export function previousTag(tags: string[], tag: string): string | null;
export function changesList(log: string): string;
export function feedNotes(notes: string): string;
export function releasePage(release: {
  notes: string;
  previous: string | null;
  tag: string;
  changes: string;
  projectUrl?: string;
}): string;
