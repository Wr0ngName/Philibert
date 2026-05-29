/**
 * Tests for escapeCwdForClaude — matches the Claude Code CLI's project
 * directory naming logic (M0 function in sdk.mjs).
 *
 * The CLI replaces every non-alphanumeric character with '-', and for
 * paths longer than 200 chars, truncates and appends a hash.
 *
 * Verified against real Windows client data:
 *   'C:\Claude\Claude Femmexpat'  →  'C--Claude-Claude-Femmexpat'
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(), realpathSync: vi.fn((p: string) => p) },
  existsSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock-user-data') },
}));

import { escapeCwdForClaude } from '../../../utils/paths';

// Old (broken) regex for regression assertions
function escapeCwdBroken(cwd: string): string {
  return cwd.replace(/[/_]/g, '-');
}

describe('escapeCwdForClaude', () => {

  describe('Windows paths', () => {
    it('escapes backslashes and colons in a typical Windows path', () => {
      expect(escapeCwdForClaude('C:\\Claude\\Claude Femmexpat')).toBe('C--Claude-Claude-Femmexpat');
    });

    it('escapes backslashes, colons, and spaces in a user home path', () => {
      expect(escapeCwdForClaude('C:\\Users\\John Doe\\project')).toBe('C--Users-John-Doe-project');
    });

    it('escapes dots in Windows drive paths', () => {
      expect(escapeCwdForClaude('C:\\Users\\user.name\\work')).toBe('C--Users-user-name-work');
    });

    it('differs from the old broken regex for Windows paths', () => {
      const cwd = 'C:\\Claude\\Claude Femmexpat';
      expect(escapeCwdBroken(cwd)).not.toBe(escapeCwdForClaude(cwd));
    });
  });

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

    it('preserves hyphens already in the path', () => {
      expect(escapeCwdForClaude('/home/user/my-project')).toBe('-home-user-my-project');
    });

    it('escapes spaces', () => {
      expect(escapeCwdForClaude('/home/user/my project')).toBe('-home-user-my-project');
    });
  });

  describe('long path truncation', () => {
    it('returns paths <= 200 chars as-is', () => {
      const cwd = '/home/' + 'a'.repeat(190);
      const result = escapeCwdForClaude(cwd);
      expect(result.length).toBeLessThanOrEqual(200);
      expect(result).toBe('-home-' + 'a'.repeat(190));
    });

    it('truncates paths > 200 chars and appends a hash', () => {
      const cwd = '/home/' + 'a'.repeat(300);
      const result = escapeCwdForClaude(cwd);
      expect(result.length).toBeGreaterThan(200);
      expect(result.length).toBeLessThan(220);
      expect(result.startsWith('-home-' + 'a'.repeat(194))).toBe(true);
      expect(result).toMatch(/-[a-z0-9]+$/);
    });

    it('produces different hashes for different long paths', () => {
      const cwd1 = '/home/' + 'a'.repeat(300);
      const cwd2 = '/home/' + 'b'.repeat(300);
      const result1 = escapeCwdForClaude(cwd1);
      const result2 = escapeCwdForClaude(cwd2);
      expect(result1).not.toBe(result2);
    });
  });

  describe('edge cases', () => {
    it('returns empty string unchanged', () => {
      expect(escapeCwdForClaude('')).toBe('');
    });

    it('preserves a string that only contains valid characters', () => {
      expect(escapeCwdForClaude('home-user-project')).toBe('home-user-project');
    });

    it('handles paths with mixed separators', () => {
      expect(escapeCwdForClaude('C:/Users/Jane/project')).toBe('C--Users-Jane-project');
    });
  });

  describe('regression against old /[/_]/g regex', () => {
    it('old regex does NOT escape backslashes', () => {
      const cwd = 'C:\\Claude\\project';
      expect(escapeCwdBroken(cwd)).toBe('C:\\Claude\\project');
      expect(escapeCwdForClaude(cwd)).toBe('C--Claude-project');
    });

    it('old regex does NOT escape spaces', () => {
      const cwd = '/home/user/my project';
      expect(escapeCwdBroken(cwd)).toBe('-home-user-my project');
      expect(escapeCwdForClaude(cwd)).toBe('-home-user-my-project');
    });

    it('old regex does NOT escape colons', () => {
      const cwd = 'C:\\work';
      expect(escapeCwdBroken(cwd)).toBe('C:\\work');
      expect(escapeCwdForClaude(cwd)).toBe('C--work');
    });
  });
});
