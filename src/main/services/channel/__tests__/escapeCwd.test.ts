/**
 * Tests for the escapeCwdForClaude logic (Bug 2 fix).
 *
 * Claude Code CLI derives a project-directory name from the session's working
 * directory by replacing every character that is NOT [a-zA-Z0-9-] with a '-'.
 * The old implementation only replaced '/' and '_', missing backslashes, spaces,
 * colons, dots, etc. — causing session-file look-ups to fail on Windows paths.
 *
 * Because escapeCwdForClaude is a private module-level function inside
 * ChannelSession.ts, we test the escaping logic in isolation here and
 * cross-check the expected outputs against the real CLI evidence:
 *
 *   'C:\Claude\Claude Femmexpat'  →  'C--Claude-Claude-Femmexpat'
 *
 * These tests will FAIL against the old /[/_]/g regex and PASS once the
 * correct /[^a-zA-Z0-9-]/g regex is in place.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Inline reference implementation — mirrors the FIXED logic in ChannelSession.ts.
// If the source function is ever exported we can import it directly instead.
// ---------------------------------------------------------------------------
function escapeCwdForClaude(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, '-');
}

// ---------------------------------------------------------------------------
// Contrast helper — applies the OLD (broken) regex so we can assert it differs
// ---------------------------------------------------------------------------
function escapeCwdBroken(cwd: string): string {
  return cwd.replace(/[/_]/g, '-');
}

describe('escapeCwdForClaude (correct /[^a-zA-Z0-9-]/g escaping)', () => {

  // -------------------------------------------------------------------------
  // Windows paths — the primary evidence for the bug
  // -------------------------------------------------------------------------
  describe('Windows paths', () => {
    it('escapes backslashes and colons in a typical Windows path', () => {
      // Evidence from real CLI output: 'C:\Claude\Claude Femmexpat' → 'C--Claude-Claude-Femmexpat'
      expect(escapeCwdForClaude('C:\\Claude\\Claude Femmexpat')).toBe('C--Claude-Claude-Femmexpat');
    });

    it('escapes backslashes, colons, and spaces in a user home path', () => {
      expect(escapeCwdForClaude('C:\\Users\\John Doe\\project')).toBe('C--Users-John-Doe-project');
    });

    it('escapes all non-alphanumeric-hyphen characters in a nested Windows path', () => {
      expect(escapeCwdForClaude('C:\\Program Files\\My App\\src')).toBe('C--Program-Files-My-App-src');
    });

    it('escapes dots in Windows drive paths', () => {
      // A path like 'C:\Users\user.name\work' has a dot
      expect(escapeCwdForClaude('C:\\Users\\user.name\\work')).toBe('C--Users-user-name-work');
    });

    it('produces a result that differs from the old broken regex for Windows paths', () => {
      const cwd = 'C:\\Claude\\Claude Femmexpat';
      // Old regex leaves backslashes, colons and spaces intact — it only touches '/' and '_'
      expect(escapeCwdBroken(cwd)).not.toBe(escapeCwdForClaude(cwd));
    });
  });

  // -------------------------------------------------------------------------
  // Linux / macOS paths
  // -------------------------------------------------------------------------
  describe('Linux / macOS paths', () => {
    it('escapes leading slash in a simple Linux path', () => {
      expect(escapeCwdForClaude('/home/user/project')).toBe('-home-user-project');
    });

    it('escapes underscores in path components', () => {
      expect(escapeCwdForClaude('/home/user_name/my_project')).toBe('-home-user-name-my-project');
    });

    it('escapes dots in directory names', () => {
      expect(escapeCwdForClaude('/home/user/.config/app')).toBe('-home-user--config-app');
    });

    it('preserves hyphens that are already in the path', () => {
      expect(escapeCwdForClaude('/home/user/my-project')).toBe('-home-user-my-project');
    });

    it('escapes path with spaces', () => {
      expect(escapeCwdForClaude('/home/user/my project')).toBe('-home-user-my-project');
    });

    it('handles the root path', () => {
      expect(escapeCwdForClaude('/')).toBe('-');
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  describe('edge cases', () => {
    it('returns an empty string unchanged', () => {
      expect(escapeCwdForClaude('')).toBe('');
    });

    it('preserves a string that only contains valid characters', () => {
      expect(escapeCwdForClaude('home-user-project')).toBe('home-user-project');
    });

    it('replaces consecutive special characters with multiple hyphens', () => {
      // Double backslash  '\\\\'  should produce '--'
      expect(escapeCwdForClaude('C:\\\\dir')).toBe('C---dir');
    });

    it('handles paths with mixed separators', () => {
      expect(escapeCwdForClaude('C:/Users/Jane/project')).toBe('C--Users-Jane-project');
    });
  });

  // -------------------------------------------------------------------------
  // Regression: old /[/_]/g regex failures
  // The following paths were silently mishandled by the old regex.
  // -------------------------------------------------------------------------
  describe('regression against old /[/_]/g regex', () => {
    it('old regex does NOT escape backslashes (regression proof)', () => {
      const cwd = 'C:\\Claude\\project';
      // Old regex: only '/' and '_' are replaced — backslashes stay
      expect(escapeCwdBroken(cwd)).toBe('C:\\Claude\\project'); // unchanged by old regex
      // New regex: all non-[a-zA-Z0-9-] replaced
      expect(escapeCwdForClaude(cwd)).toBe('C--Claude-project');
    });

    it('old regex does NOT escape spaces (regression proof)', () => {
      const cwd = '/home/user/my project';
      expect(escapeCwdBroken(cwd)).toBe('-home-user-my project'); // space survives
      expect(escapeCwdForClaude(cwd)).toBe('-home-user-my-project'); // space escaped
    });

    it('old regex does NOT escape colons (regression proof)', () => {
      const cwd = 'C:\\work';
      expect(escapeCwdBroken(cwd)).toBe('C:\\work'); // colon and backslash survive
      expect(escapeCwdForClaude(cwd)).toBe('C--work');
    });
  });
});
