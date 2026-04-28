/**
 * Resource Paths Utility
 *
 * Centralized utility for computing resource paths in Electron apps.
 * Handles differences between development and packaged environments,
 * and platform-specific paths (Windows vs Unix).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { app } from 'electron';

/**
 * Get the base resources path for the application.
 *
 * In packaged apps: process.resourcesPath (e.g., /path/to/app/resources)
 * In development: directory containing the app (e.g., /path/to/project)
 */
export function getResourcesPath(): string {
  return process.resourcesPath || path.dirname(app.getAppPath());
}

/**
 * Windows-specific resource paths
 */
export const WindowsPaths = {
  getBundledNodeExe(): string {
    return path.join(getResourcesPath(), 'node.exe');
  },

  hasBundledNode(): boolean {
    return fs.existsSync(this.getBundledNodeExe());
  },

  getGitBashDir(): string {
    return path.join(getResourcesPath(), 'git-bash');
  },

  getGitBashBinDir(): string {
    return path.join(this.getGitBashDir(), 'usr', 'bin');
  },

  getGitBashMingwBin(): string {
    return path.join(this.getGitBashDir(), 'mingw64', 'bin');
  },

  getBashExe(): string {
    return path.join(this.getGitBashBinDir(), 'bash.exe');
  },

  hasBundledGitBash(): boolean {
    return fs.existsSync(this.getBashExe());
  },

  getGitBashArchive(): string {
    return path.join(getResourcesPath(), 'git-bash.tar.bz2');
  },

  getGitBashVersionFile(): string {
    return path.join(getResourcesPath(), 'version.txt');
  },

  getExtractedVersionFile(): string {
    return path.join(this.getGitBashDir(), '.version');
  },

  getBundleTypeFile(): string {
    return path.join(getResourcesPath(), 'bundle-type.txt');
  },

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
      // Default to offline
    }
    return 'offline';
  },

  isOnlineBundle(): boolean {
    return this.getBundleType() === 'online';
  },

  buildEnhancedPath(currentPath: string = ''): string {
    const basePath = currentPath || process.env.PATH || '';
    return `${this.getGitBashBinDir()};${this.getGitBashMingwBin()};${basePath}`;
  },
};

/**
 * Claude CLI paths
 */
export const ClaudeCliPaths = {
  getBundledCliPaths(): string[] {
    const resourcesPath = getResourcesPath();
    const asarUnpacked = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-code');
    const devPath = path.join(app.getAppPath(), 'node_modules', '@anthropic-ai', 'claude-code');

    return [
      path.join(asarUnpacked, 'bin', 'claude.exe'),
      path.join(devPath, 'bin', 'claude.exe'),
      path.join(asarUnpacked, 'cli-wrapper.cjs'),
      path.join(devPath, 'cli-wrapper.cjs'),
      path.join(asarUnpacked, 'cli.js'),
      path.join(devPath, 'cli.js'),
    ];
  },

  findBundledCli(): string | null {
    for (const cliPath of this.getBundledCliPaths()) {
      if (fs.existsSync(cliPath)) {
        return cliPath;
      }
    }
    return null;
  },

  isNativeBinary(cliPath: string): boolean {
    return cliPath.endsWith('claude.exe') && !cliPath.endsWith('.cjs') && !cliPath.endsWith('.js');
  },
};
