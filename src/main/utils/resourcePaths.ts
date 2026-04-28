/**
 * Resource Paths Utility
 *
 * Centralized utility for computing resource paths in Electron apps.
 * Handles differences between development and packaged environments,
 * and platform-specific paths (Windows vs Unix).
 *
 * This eliminates duplicated path calculations across:
 * - AuthService.ts
 * - ClaudeCodeService.ts
 * - gitBashExtractor.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { app } from 'electron';

/**
 * Get the base resources path for the application.
 *
 * In packaged apps: process.resourcesPath (e.g., /path/to/app/resources)
 * In development: directory containing the app (e.g., /path/to/project)
 *
 * NOTE: For Squirrel events (install/update), use getResourcesPathForSquirrel()
 * since `app` may not be available yet.
 */
export function getResourcesPath(): string {
  return process.resourcesPath || path.dirname(app.getAppPath());
}

/**
 * Get the resources path for Squirrel install/update events.
 *
 * During Squirrel events, the `app` module may not be fully initialized,
 * so we use process.execPath as fallback instead of app.getAppPath().
 */
export function getResourcesPathForSquirrel(): string {
  return process.resourcesPath || path.dirname(process.execPath);
}

/**
 * Windows-specific resource paths
 */
export const WindowsPaths = {
  /**
   * Get the path to the bundled Node.js executable (Windows only)
   */
  getBundledNodeExe(): string {
    return path.join(getResourcesPath(), 'node.exe');
  },

  /**
   * Check if bundled Node.js is available
   */
  hasBundledNode(): boolean {
    return fs.existsSync(this.getBundledNodeExe());
  },

  /**
   * Get the Git Bash root directory
   */
  getGitBashDir(): string {
    return path.join(getResourcesPath(), 'git-bash');
  },

  /**
   * Get the path to Git Bash's usr/bin directory
   */
  getGitBashBinDir(): string {
    return path.join(this.getGitBashDir(), 'usr', 'bin');
  },

  /**
   * Get the path to Git Bash's mingw64/bin directory
   */
  getGitBashMingwBin(): string {
    return path.join(this.getGitBashDir(), 'mingw64', 'bin');
  },

  /**
   * Get the path to bash.exe
   */
  getBashExe(): string {
    return path.join(this.getGitBashBinDir(), 'bash.exe');
  },

  /**
   * Check if bundled Git Bash is available
   */
  hasBundledGitBash(): boolean {
    return fs.existsSync(this.getBashExe());
  },

  /**
   * Get the path to git-bash.tar.bz2 archive
   */
  getGitBashArchive(): string {
    return path.join(getResourcesPath(), 'git-bash.tar.bz2');
  },

  /**
   * Get the version.txt file for Git Bash bundle
   */
  getGitBashVersionFile(): string {
    return path.join(getResourcesPath(), 'version.txt');
  },

  /**
   * Get the extracted version marker file
   */
  getExtractedVersionFile(): string {
    return path.join(this.getGitBashDir(), '.version');
  },

  /**
   * Build enhanced PATH with Git Bash directories prepended.
   * This ensures cygpath and other Git Bash utilities are found.
   */
  buildEnhancedPath(currentPath: string = ''): string {
    const basePath = currentPath || process.env.PATH || '';
    return `${this.getGitBashBinDir()};${this.getGitBashMingwBin()};${basePath}`;
  },
};

/**
 * Paths for Squirrel events (install/update on Windows)
 * Uses getResourcesPathForSquirrel() since app may not be initialized.
 */
export const SquirrelPaths = {
  /**
   * Get the Git Bash root directory for Squirrel events
   */
  getGitBashDir(): string {
    return path.join(getResourcesPathForSquirrel(), 'git-bash');
  },

  /**
   * Get the path to git-bash.tar.bz2 archive
   */
  getGitBashArchive(): string {
    return path.join(getResourcesPathForSquirrel(), 'git-bash.tar.bz2');
  },

  /**
   * Get the bundled version.txt file
   */
  getBundledVersionFile(): string {
    return path.join(getResourcesPathForSquirrel(), 'version.txt');
  },

  /**
   * Get the extracted version marker file
   */
  getExtractedVersionFile(): string {
    return path.join(this.getGitBashDir(), '.version');
  },

  /**
   * Get the path to bash.exe for verification
   */
  getBashExe(): string {
    return path.join(this.getGitBashDir(), 'usr', 'bin', 'bash.exe');
  },

  /**
   * Get the path to bundle-type.txt marker file
   */
  getBundleTypeFile(): string {
    return path.join(getResourcesPathForSquirrel(), 'bundle-type.txt');
  },

  /**
   * Get the bundle type (online or offline)
   * Returns 'offline' if file doesn't exist or is unreadable
   */
  getBundleType(): 'online' | 'offline' {
    try {
      const bundleTypeFile = this.getBundleTypeFile();
      if (fs.existsSync(bundleTypeFile)) {
        const content = fs.readFileSync(bundleTypeFile, 'utf8').trim();
        if (content === 'online') {
          return 'online';
        }
      }
    } catch {
      // Ignore errors, default to offline
    }
    return 'offline';
  },

  /**
   * Check if this is an online bundle (requires downloading dependencies)
   */
  isOnlineBundle(): boolean {
    return this.getBundleType() === 'online';
  },

  /**
   * Get the path to bundled Node.js executable
   */
  getBundledNodeExe(): string {
    return path.join(getResourcesPathForSquirrel(), 'node.exe');
  },

  /**
   * Check if bundled Node.js exists
   */
  hasBundledNode(): boolean {
    return fs.existsSync(this.getBundledNodeExe());
  },
};

/**
 * Claude CLI paths
 */
export const ClaudeCliPaths = {
  /**
   * Get all possible bundled CLI paths (in order of preference).
   * v2.1.121+ ships a native binary at bin/claude.exe; older versions used cli.js.
   */
  getBundledCliPaths(): string[] {
    const resourcesPath = getResourcesPath();
    const asarUnpacked = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-code');
    const devPath = path.join(app.getAppPath(), 'node_modules', '@anthropic-ai', 'claude-code');

    return [
      // v2.1.121+ native binary
      path.join(asarUnpacked, 'bin', 'claude.exe'),
      path.join(devPath, 'bin', 'claude.exe'),
      // v2.1.121+ Node.js fallback wrapper
      path.join(asarUnpacked, 'cli-wrapper.cjs'),
      path.join(devPath, 'cli-wrapper.cjs'),
      // Legacy cli.js (v2.1.31 and earlier)
      path.join(asarUnpacked, 'cli.js'),
      path.join(devPath, 'cli.js'),
    ];
  },

  /**
   * Find the first existing CLI path
   */
  findBundledCli(): string | null {
    for (const cliPath of this.getBundledCliPaths()) {
      if (fs.existsSync(cliPath)) {
        return cliPath;
      }
    }
    return null;
  },

  /**
   * Check if a CLI path is a native binary (not a Node.js script).
   */
  isNativeBinary(cliPath: string): boolean {
    return cliPath.endsWith('claude.exe') && !cliPath.endsWith('.cjs') && !cliPath.endsWith('.js');
  },
};
